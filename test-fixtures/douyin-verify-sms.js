// 开发用的模拟「身份验证」框，照用户实机碰到的抖音验证框文案做的（真实结构等诊断文件，见 collector/diagnostics/verify-*.html）。
// 用法：在开发版的隐藏登录页里塞一个地址带 /verifycenter/ 的子框架，再在那个子框架里执行这个文件的内容，例如主进程里
//   frame.executeJavaScript(readFileSync("test-fixtures/douyin-verify-sms.js", "utf8"))
// 选「接收短信验证码」→ 打码手机号、获取验证码（倒计时）、输入框、验证；填 123456 算通过，验证框随之收掉，别的数字提示错误。
(() => {
  const root = document.body;
  const view = html => { root.innerHTML = `<div class="verify-panel-x1y2">${html}</div>`; };
  const list = () => {
    view(`<div class="title-a9">身份验证</div><div class="desc-b3">为保障账号安全，请先完成身份验证</div>
      <ul><li class="way-c1"><span>接收短信验证码</span></li><li class="way-c1"><span>验证登录密码</span></li><li class="way-c1"><span>发送短信验证</span></li></ul>`);
    root.querySelectorAll("li")[0].addEventListener("click", sms);
  };
  const sms = () => {
    view(`<div class="title-a9">短信验证</div><div class="desc-b3">验证码将发送至 182****8686</div>
      <div class="row-d4"><input class="input-e5" placeholder="请输入短信验证码" maxlength="6"><span class="send-f6">获取验证码</span></div>
      <div class="tip-g7"></div><button class="submit-h8">验证</button>`);
    const send = root.querySelector(".send-f6"), tip = root.querySelector(".tip-g7");
    send.addEventListener("click", () => {
      if (!/获取/u.test(send.textContent)) return;
      let left = 59;
      send.textContent = `${left}s后重新获取`;
      const timer = setInterval(() => { left -= 1; send.textContent = left > 0 ? `${left}s后重新获取` : "重新获取"; if (left <= 0) clearInterval(timer); }, 1000);
    });
    root.querySelector(".submit-h8").addEventListener("click", () => {
      if (root.querySelector("input").value === "123456") { tip.textContent = "验证成功"; setTimeout(() => window.frameElement?.remove(), 500); }
      else tip.textContent = "验证码错误，请重新输入";
    });
  };
  list();
  return true;
})();
