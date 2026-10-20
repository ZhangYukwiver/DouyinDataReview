// 开发用的模拟「身份验证」框，照 2026-10-20 远端 Windows 真实触发时存下的诊断快照做的：
// 登录跳到 /user/self 后页面里盖一层 #uc-second-verify（不是 iframe），类名是哈希，这里只保留文字和结构。
// 用法：在开发版的隐藏登录页主框架里执行这个文件的内容，例如主进程里
//   page.contents.executeJavaScript(readFileSync("test-fixtures/douyin-verify-sms.js", "utf8"))
// 选「接收短信验证码」→ 直接发短信（打码手机号、N 秒后重新发送）、输入框、取消/验证；填 123456 算通过，浮层随之收掉，别的数字提示错误。
(() => {
  document.querySelector("#uc-second-verify")?.remove();
  const root = document.createElement("div");
  root.id = "uc-second-verify";
  root.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5)";
  document.body.append(root);
  const view = html => { root.innerHTML = `<article class="layout-x1" style="background:#fff;width:420px;margin:120px auto;padding:24px">${html}</article>`; };
  const list = () => {
    view(`<div class="title-a9"><span>身份验证</span></div><div class="desc-b3"><span>为保障账号安全，请先完成身份验证，以确保为本人操作</span></div>
      <div class="name-c0">多拉贡</div><div class="list-c1">
      <div class="item-c2"><div class="content-c3"><div>接收短信验证码</div></div></div>
      <div class="item-c2"><div class="content-c3"><div>验证登录密码</div></div></div>
      <div class="item-c2"><div class="content-c3"><div>发送短信验证</div></div></div></div>`);
    root.querySelector(".item-c2").addEventListener("click", sms);
  };
  const sms = () => {
    view(`<div class="title-a9">接收短信验证码</div><div class="desc-b3"><div></div></div>
      <div><span>短信已发送至<span class="bold-d1">182******27</span></span></div>
      <div class="button_input-e5"><input id="button-input" placeholder="请输入验证码" autocomplete="off" maxlength="6" type="tel" value=""><span class="button_text-f6">重新发送</span></div>
      <div class="err_tip-g7"></div>
      <div class="footer-h8"><div class="btn-h9">取消</div><div class="btn-h9 primary">验证</div><p>无法验证通过？<span class="href">选择其他验证方式</span></p></div>`);
    const send = root.querySelector(".button_text-f6"), tip = root.querySelector(".err_tip-g7");
    let timer = null;
    const countdown = () => {
      let left = 59;
      send.textContent = `${left}s后重新发送`;
      clearInterval(timer);
      timer = setInterval(() => { left -= 1; send.textContent = left > 0 ? `${left}s后重新发送` : "重新发送"; if (left <= 0) clearInterval(timer); }, 1000);
    };
    countdown();
    send.addEventListener("click", () => { if (send.textContent === "重新发送") countdown(); });
    root.querySelector(".primary").addEventListener("click", () => {
      if (root.querySelector("input").value === "123456") { clearInterval(timer); root.remove(); }
      else tip.textContent = "验证码错误，请重新输入";
    });
  };
  list();
  return true;
})();
