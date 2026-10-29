package expo.modules.douyinnative

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.webkit.CookieManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

private const val ORIGIN = "https://www.douyin.com"
private val PATHS = setOf("/aweme/v1/web/user/profile/self/", "/aweme/v1/web/query/user/",
  "/aweme/v1/web/history/read/", "/aweme/v1/web/aweme/favorite/", "/aweme/v1/web/aweme/listcollection/")
private val SAFE = setOf("device_platform", "aid", "channel", "update_version_code", "pc_client_type", "pc_libra_divert",
  "support_h265", "support_dash", "version_code", "version_name", "cookie_enabled", "screen_width", "screen_height",
  "browser_language", "browser_platform", "browser_name", "browser_version", "browser_online", "engine_name",
  "engine_version", "os_name", "os_version", "cpu_core_num", "device_memory", "platform", "downlink", "effective_type", "round_trip_time", "webid")

class DouyinNativeModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext)
  private val preferences get() = context.getSharedPreferences("douyin-direct-context", Context.MODE_PRIVATE)
  private fun saved(): JSONObject = JSONObject(preferences.getString("context", null) ?: error("context_missing"))
  private fun cookieHeader(): String {
    val header = CookieManager.getInstance().getCookie(ORIGIN) ?: ""
    if (!Regex("(?:^|;\\s*)(sessionid|sessionid_ss|sid_tt|sid_guard)=.+").containsMatchIn(header)) error("login")
    return header
  }
  private fun cookie(header: String, name: String): String = header.split(';').firstOrNull {
    it.trim().startsWith("$name=")
  }?.trim()?.substringAfter('=') ?: ""

  override fun definition() = ModuleDefinition {
    Name("DouyinNative")

    AsyncFunction("hasContext") { preferences.contains("context") }

    // Only non-secret browser/request parameters are persisted. CookieManager owns the login.
    AsyncFunction("configure") { raw: String ->
      val input = JSONObject(raw)
      val ua = input.getString("userAgent")
      require(ua.startsWith("Mozilla/5.0 ") && ua.length <= 500 && !ua.contains('\n') && !ua.contains('\r'))
      val values = input.getJSONObject("values")
      require(values.optString("aid") == "6383" && values.optString("webid").matches(Regex("[0-9]{1,30}")))
      val safe = JSONObject()
      for (name in SAFE) if (values.has(name)) {
        val value = values.getString(name)
        require(value.length <= 500 && !value.contains('\n') && !value.contains('\r'))
        safe.put(name, value)
      }
      preferences.edit().putString("context", JSONObject().put("userAgent", ua).put("values", safe).toString()).commit()
    }

    // Signing parameters cross the in-process bridge only in memory; the Cookie header never does.
    AsyncFunction("prepare") { path: String, queryRaw: String ->
      require(path in PATHS)
      val session = saved()
      val values = session.getJSONObject("values")
      val query = JSONObject(queryRaw)
      val header = cookieHeader()
      val builder = Uri.parse(ORIGIN + path).buildUpon()
      for (name in values.keys()) if (name in SAFE && !query.has(name)) builder.appendQueryParameter(name, values.getString(name))
      for (name in query.keys()) {
        require(name in setOf("count", "max_cursor", "min_cursor", "cursor", "directory", "category", "status", "sec_user_id", "whale_cut_token", "cut_version", "publish_video_strategy_type"))
        val value = query.getString(name)
        require(value.length <= 240)
        builder.appendQueryParameter(name, value)
      }
      for ((parameter, name) in listOf("verifyFp" to "s_v_web_id", "fp" to "s_v_web_id", "uifid" to "UIFID", "msToken" to "msToken")) {
        val value = cookie(header, name)
        if (value.isNotEmpty()) builder.appendQueryParameter(parameter, value)
      }
      mapOf("url" to builder.build().toString(), "userAgent" to session.getString("userAgent"))
    }

    AsyncFunction("request") { signed: String, body: String? ->
      val url = URL(signed)
      require(url.protocol == "https" && url.host == "www.douyin.com" && url.port == -1 && url.userInfo == null && url.ref == null && url.path in PATHS)
      require((url.path == "/aweme/v1/web/aweme/listcollection/") == (body != null))
      require(body == null || body.matches(Regex("count=10&cursor=[0-9]{1,20}")))
      require(Uri.parse(signed).getQueryParameter("a_bogus")?.matches(Regex("[A-Za-z0-9+/_=-]{64,512}")) == true)
      val header = cookieHeader()
      val ua = saved().getString("userAgent")
      val uifid = cookie(header, "UIFID")
      var target = signed
      if (url.path.contains("/aweme/favorite/") || url.path.contains("/aweme/listcollection/")) {
        val now = System.currentTimeMillis() / 1000
        val query = "${url.query}&timestamp=$now"
        val raw = "${uifid}_${now}_A96D855A08C0A9707F8BEF0D9A527E4E_${query}"
        val digest = MessageDigest.getInstance("MD5").digest(raw.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        target = "$ORIGIN${url.path}?$query&x-secsdk-web-signature=$digest"
      }
      val connection = URL(target).openConnection() as HttpsURLConnection
      try {
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        connection.useCaches = false
        connection.setRequestProperty("User-Agent", ua)
        connection.setRequestProperty("Cookie", header)
        connection.setRequestProperty("Accept", "application/json, text/plain, */*")
        connection.setRequestProperty("Referer", "$ORIGIN/user/self?showTab=record")
        connection.setRequestProperty("sec-fetch-site", "same-origin")
        connection.setRequestProperty("sec-fetch-mode", "cors")
        connection.setRequestProperty("sec-fetch-dest", "empty")
        if (uifid.isNotEmpty()) connection.setRequestProperty("uifid", uifid)
        if (body != null) {
          connection.requestMethod = "POST"
          connection.doOutput = true
          connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
          connection.outputStream.use { it.write(body.toByteArray()) }
        }
        val status = connection.responseCode
        if (status == 401 || status == 403) error("login")
        if (status == 429) error("limited")
        if (status != 200) error("rejected")
        if (connection.contentLengthLong > 8000000) error("format")
        val bytes = connection.inputStream.use { it.readBytesLimited(8000000) }
        for ((name, values) in connection.headerFields) if (name.equals("Set-Cookie", ignoreCase = true)) {
          for (value in values) CookieManager.getInstance().setCookie(ORIGIN, value)
        }
        connection.getHeaderField("x-ms-token")?.takeIf { it.matches(Regex("[A-Za-z0-9+/_=-]{100,1024}")) }?.let {
          CookieManager.getInstance().setCookie(ORIGIN, "msToken=$it; Path=/; Secure")
        }
        CookieManager.getInstance().flush()
        String(bytes, Charsets.UTF_8)
      } finally { connection.disconnect() }
    }

    AsyncFunction("readStoryAsset") { name: String ->
      require(name in setOf("story-entry.html", "story-draft_副本.html", "story-poster.html", "story-archive.html", "story-glide.js", "story-export.js", "story-card.js")
        || name.matches(Regex("story-images/[a-z0-9-]+\\.(jpg|png)")))
      context.assets.open("story/$name").use { stream ->
        val bytes = stream.readBytesLimited(20000000)
        if (name.endsWith(".jpg") || name.endsWith(".png")) "data:image/${if (name.endsWith(".jpg")) "jpeg" else "png"};base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        else String(bytes, Charsets.UTF_8)
      }
    }
  }
}

private fun java.io.InputStream.readBytesLimited(limit: Int): ByteArray {
  val output = java.io.ByteArrayOutputStream()
  val buffer = ByteArray(8192)
  while (true) {
    val count = read(buffer)
    if (count < 0) break
    if (output.size() + count > limit) error("format")
    output.write(buffer, 0, count)
  }
  return output.toByteArray()
}
