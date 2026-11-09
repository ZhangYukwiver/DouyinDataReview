import React, { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react-native";
import "./CommentImagePreview.css";

export function CommentImageThumbnails({ images, onPreview }: { images?: string[]; onPreview: (src: string) => void }) {
  if (!images?.length) return null;
  return <div className="comment-image-thumbnails">{images.map((src, i) =>
    <button type="button" key={`${i}:${src}`} aria-label={`放大第 ${i + 1} 张评论图片`} aria-haspopup="dialog" onClick={() => onPreview(src)}>
      <img src={src} alt="评论图片或表情" referrerPolicy="no-referrer" loading="lazy" />
    </button>)}</div>;
}

export function CommentImagePreview({ src, onClose }: { src: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="comment-image-preview" aria-label="评论图片预览" onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}
    // 外层播放器弹窗在 keyup 处理 Esc，这里消费同一次按键，只关闭图片。
    onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}
    onKeyUp={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.close(); }
    }}>
    <img src={src} alt="放大的评论图片" referrerPolicy="no-referrer" />
    <button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><X color="#fff" size={24} /></button>
  </dialog>;
}
