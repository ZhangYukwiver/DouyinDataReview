#!/usr/bin/env bash
set -euo pipefail

ffmpeg_version="7.1.1"
ffmpeg_sha256="733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
lame_version="4.0"
lame_sha256="3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb"
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="${MEDIA_TARGET_PLATFORM:-$(node -p 'process.platform')}"
arch="${MEDIA_TARGET_ARCH:-$(node -p 'process.arch')}"
target="${platform}-${arch}"
if [[ "$platform" == "darwin" ]]; then
  macos_deployment_target="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
  [[ "$macos_deployment_target" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || { echo "Invalid MACOSX_DEPLOYMENT_TARGET: $macos_deployment_target" >&2; exit 1; }
  export MACOSX_DEPLOYMENT_TARGET="$macos_deployment_target"
else
  macos_deployment_target=""
fi
source_directory="${MEDIA_TOOLS_SOURCE_DIR:-$project_directory/build/media-tools-source}"
cache_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
if [[ "$platform" == "win32" ]]; then
  source_directory="$(cygpath -u "$source_directory")"
  cache_root="$(cygpath -u "$cache_root")"
  export PATH="/mingw64/bin:$PATH"
fi
cache_directory="$cache_root/douyin-ffmpeg-${ffmpeg_version}"
archive="$cache_directory/ffmpeg-${ffmpeg_version}.tar.xz"
lame_archive="$cache_directory/lame-${lame_version}.tar.gz"
build_suffix="$target${macos_deployment_target:+-macos${macos_deployment_target//./_}}"
build_directory="$cache_directory/build-${build_suffix}"
source="$build_directory/ffmpeg-${ffmpeg_version}"
lame_source="$build_directory/lame-${lame_version}"
lame_prefix="$cache_directory/lame-prefix-${build_suffix}"
prefix="$cache_directory/prefix-${build_suffix}-lame${lame_version}"

if [[ "$target" != "darwin-arm64" && "$target" != "win32-x64" && "$target" != "linux-x64" ]]; then
  echo "Unsupported media tool target: $target" >&2
  exit 1
fi

mkdir -p "$build_directory"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 -o "$archive" "https://ffmpeg.org/releases/ffmpeg-${ffmpeg_version}.tar.xz"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
[[ "$actual_sha256" == "$ffmpeg_sha256" ]] || { echo "FFmpeg source checksum mismatch" >&2; exit 1; }
if [[ ! -f "$source/configure" ]]; then
  tar -xJf "$archive" -C "$build_directory"
fi

if [[ ! -f "$lame_archive" ]]; then
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 -o "$lame_archive" "https://downloads.sourceforge.net/project/lame/lame/${lame_version}/lame-${lame_version}.tar.gz"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$lame_archive" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$lame_archive" | awk '{print $1}')"
fi
[[ "$actual_sha256" == "$lame_sha256" ]] || { echo "LAME source checksum mismatch" >&2; exit 1; }
if [[ ! -f "$lame_source/configure" ]]; then
  tar -xzf "$lame_archive" -C "$build_directory"
fi

if [[ ! -f "$lame_prefix/lib/libmp3lame.a" ]]; then
  rm -rf "$lame_prefix"
  mkdir -p "$lame_prefix"
  lame_configure_args=("--prefix=$lame_prefix" --disable-shared --enable-static --disable-decoder --disable-frontend)
  if [[ "$platform" == "win32" ]]; then
    lame_configure_args+=(--host=x86_64-w64-mingw32 --build=x86_64-pc-msys)
  fi
  (
    cd "$lame_source"
    if [[ "$platform" == "win32" ]]; then
      # MSYS2 的 MINGW64 只给 gcc 带前缀，ar/ranlib 等 binutils 不带前缀
      CC=x86_64-w64-mingw32-gcc AR=ar RANLIB=ranlib ./configure "${lame_configure_args[@]}"
    else
      ./configure "${lame_configure_args[@]}"
    fi
    make -j"${JOBS:-2}"
    make install
  )
fi

if [[ ! -x "$prefix/bin/ffmpeg" || ! -x "$prefix/bin/ffprobe" ]]; then
  rm -rf "$prefix"
  mkdir -p "$prefix"
  configure_args=(
    "--prefix=$prefix" --disable-debug --disable-doc --disable-ffplay --disable-network
    --disable-autodetect --disable-everything --enable-ffmpeg --enable-ffprobe
    --enable-protocol=file --enable-demuxer=mov,matroska,ogg,mp3,wav,aac,flac
    --enable-muxer=mp3,wav,image2,image2pipe,null
    --enable-decoder=h264,hevc,vp8,vp9,av1,aac,mp3,opus,vorbis,flac,pcm_s16le,pcm_s16le_planar
    --enable-encoder=libmp3lame,pcm_s16le,mjpeg
    --enable-parser=h264,hevc,vp8,vp9,av1,aac,mpegaudio,opus,vorbis,flac
    --enable-filter=aresample,format,scale,select,showinfo,volumedetect,silencedetect
    --enable-swscale --enable-swresample --enable-small --enable-libmp3lame
    --pkg-config-flags=--static
  )
  configure_args+=("--extra-cflags=-I$lame_prefix/include" "--extra-ldflags=-L$lame_prefix/lib")
  if [[ "$platform" == "win32" ]]; then
    configure_args+=(--enable-cross-compile --target-os=mingw32 --arch=x86_64
      --cc=x86_64-w64-mingw32-gcc --ar=ar --nm=nm --ranlib=ranlib --strip=strip --windres=windres
      --pkg-config=pkg-config --extra-libs=-static)
  elif [[ "$platform" == "linux" ]]; then
    # 静态链接：不跟着构建机的 glibc 版本走，老一点的发行版也能跑
    configure_args+=(--extra-libs=-static)
  fi
  (cd "$source" && PKG_CONFIG_PATH="$lame_prefix/lib/pkgconfig" ./configure "${configure_args[@]}"
    make -j"${JOBS:-2}" && make install)
fi

target_directory="$source_directory/$target"
mkdir -p "$target_directory"
if [[ "$platform" == "win32" ]]; then
  cp "$prefix/bin/ffmpeg.exe" "$target_directory/ffmpeg.exe"
  cp "$prefix/bin/ffprobe.exe" "$target_directory/ffprobe.exe"
else
  cp "$prefix/bin/ffmpeg" "$target_directory/ffmpeg"
  cp "$prefix/bin/ffprobe" "$target_directory/ffprobe"
  chmod 755 "$target_directory/ffmpeg" "$target_directory/ffprobe"
fi
echo "Built LGPL FFmpeg ${ffmpeg_version} tools for ${target} in ${target_directory}."

