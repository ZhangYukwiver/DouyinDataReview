// 网页片段的宿主约定，摘自 openfilm（MIT，见 collector/licenses/openfilm-LICENSE.txt）src/host.mjs：
// 页面脚本跑之前先放 window.filmHost、媒体跳帧修正和固定时钟（同一个 t 永远画同一帧）；film.html 由 vendor/timeline.mjs 播放。
// 带英文注释的常量和函数照原文搬，中文注释的部分是本项目加的。


// Media seeks that land inside the frame they name. A plain `video.currentTime = t` at a frame boundary otherwise
// shows the previous frame about a third of the time. Every page that draws a film by seeking video runs it first,
// so the same t shows the same source frame in `look`, `render` and Studio's export.
export const SEEK_INSIDE_FRAME = `(()=>{const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');if(d.set.__film)return;const set=function(v){d.set.call(this,Number(v)+0.001)};set.__film=true;Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,enumerable:true,get(){return d.get.call(this)},set})})();`;
// The film's clock, for a page hosted to be drawn. Until the host draws the first frame the page runs on real time
// (loading may wait on timers and clocks); from then on, everything a page can read time from says the frame's t:
// `performance.now()` and requestAnimationFrame's timestamp are t in ms, `Date` is t after a fixed epoch, CSS and
// Web Animations the page left running stand at t (a CSS transition, whose progress is history, is finished), and
// `Math.random` restarts from a seed of t (and runs from a fixed seed while loading). So a page drawn with CSS
// keyframes, a requestAnimationFrame loop or random particles still draws the same picture for the same t, whatever
// was drawn before. The host calls `filmHost.time(t)` before `film.frame(t)` and `filmHost.settle(t)` after it;
// `filmHost.now()` is the real clock, for the host's own waiting.
export const FILM_CLOCK = `(()=>{const H=window.filmHost;if(!H||H.time)return;const P=performance,now=P.now.bind(P),D=Date,raf=window.requestAnimationFrame.bind(window),EPOCH=D.UTC(2026,0,1);let v=null,seed=0x2545f491;H.now=now;P.now=()=>v==null?now():v;function FilmDate(...a){const d=a.length||v==null?new D(...a):new D(EPOCH+v);return new.target?d:d.toString()}FilmDate.prototype=D.prototype;FilmDate.now=()=>v==null?D.now():EPOCH+v;FilmDate.parse=D.parse;FilmDate.UTC=D.UTC;window.Date=FilmDate;window.requestAnimationFrame=(cb)=>raf((ts)=>cb(v==null?ts:v));Math.random=()=>{seed=seed+0x6d2b79f5|0;let x=Math.imul(seed^seed>>>15,1|seed);x=x+Math.imul(x^x>>>7,61|x)^x;return((x^x>>>14)>>>0)/4294967296};const mine=new WeakSet();H.time=(t)=>{v=t*1000;seed=(Math.round(t*1e6)^0x2545f491)|0};H.settle=(t)=>{for(const a of document.getAnimations?.()??[]){if(typeof CSSTransition!=='undefined'&&a instanceof CSSTransition){a.finish();continue}if(!mine.has(a)){if(a.playState==='paused'||a.playState==='idle')continue;mine.add(a)}a.pause();a.currentTime=t*1000}}})();`;
// Before any page script: the host flag, the seek fix and the clock above.
export const HOST_FLAG = `window.filmHost={version:'0.1',name:'film'};${SEEK_INSIDE_FRAME}${FILM_CLOCK}`;


/**
 * The start of a film, before the timeline takes its clips over: nothing shows, a page clip has the stage's size to
 * lay itself out for while it loads (the timeline then places every clip on the element itself), and a video or sound
 * clip loads nothing as it is read (the timeline gives a video its file when the playhead comes near it): a film of a
 * hundred clips would otherwise open a hundred files at once, and its first frame wait behind them.
 */
export const filmStart = (stage) => `<style>html,body{margin:0;overflow:hidden}:where(body){background:#000}`
  + `body>section{display:contents}body>section>:is(iframe,video,img,audio){position:absolute;left:0;top:0;margin:0;visibility:hidden}`
  + `body>section>iframe{border:0;width:${stage.w}px;height:${stage.h}px}:where(body>section>:is(video,img)){object-fit:contain}</style>`
  + `<script>${HOLD_MEDIA}</script>`
  + `<script type="module" src="__film/timeline.mjs"></script>`;
/* a clip's <video> or <audio> as the parser makes it: no loading (a media element starts loading in a task after its
   src is set; this runs before, at the end of the parser's task) */
const HOLD_MEDIA = `(()=>{const o=new MutationObserver((list)=>{for(const m of list)for(const n of m.addedNodes)if((n.localName==='video'||n.localName==='audio')&&n.parentNode?.localName==='section')n.preload='none'});o.observe(document,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',()=>o.disconnect(),{once:true})})();`;


/**
 * The film's page clips served without loading: each <iframe>'s `src` is `data-film-src`. The timeline opens pages
 * itself, a few at a time and only those near the playhead in a film of many (it reads the clips from the file as
 * written); a page the parser had started loading would be cut short, a failed request to every host.
 * @param {string} html
 */
export function holdPages(html) {
  return html.replace(/<iframe\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => tag.replace(
    /(\s)([^\s=>"'/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?/g,
    (attr, space, name, value = '') => (name.toLowerCase() === 'src' ? `${space}data-film-src${value}` : attr),
  ));
}

export function injectFirst(html, tag) {
  const firstScript = html.search(/<script\b/i);
  const prefix = firstScript < 0 ? html : html.slice(0, firstScript);
  const head = /<head\b[^>]*>/i.exec(prefix);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + tag + html.slice(doctype[0].length) : tag + html;
}


// 看板预览：页面放在跨源 iframe 里（应用页面和采集器不同源），父页面发 { film: "frame", t }，这里按宿主约定画好再回
// { film: "drawn", t, meta }；画的时候又来了新的 t 只画最后一个。直接打开或在渲染用的浏览器里（没有父页面）什么都不做。
export const BRIDGE = `(()=>{if(window.parent===window)return;let busy=false,next=null,meta=null;`
  + `const ready=()=>meta??=(async()=>{for(let i=0;i<200&&!(window.film&&typeof window.film.frame==='function');i++)await new Promise((r)=>setTimeout(r,50));`
  + `const f=window.film;if(!f||typeof f.frame!=='function')throw new Error('页面没有定义 window.film.frame');await(typeof f.ready==='function'?f.ready():f.ready);await document.fonts?.ready;`
  + `return{duration:f.duration??null,width:f.width??null,height:f.height??null}})();`
  + `const draw=async()=>{if(busy)return;busy=true;while(next!=null){const t=next;next=null;try{const m=await ready();window.filmHost.time(t);await window.film.frame(t);window.filmHost.settle(t);`
  + `parent.postMessage({film:'drawn',t,meta:m},'*')}catch(e){meta=null;parent.postMessage({film:'error',message:String(e?.message??e).slice(0,300)},'*')}}busy=false};`
  + `addEventListener('message',(e)=>{if(e.source!==parent||e.data?.film!=='frame')return;next=Math.max(0,Number(e.data.t)||0);void draw()});`
  + `addEventListener('error',(e)=>parent.postMessage({film:'error',message:String(e.message).slice(0,300)},'*'));})();`;

// AI 写的网页只许从自己的文件夹（同源）和几个常用 CDN 拿脚本、样式、字体；不能往外发请求，免得把素材带出去
const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh";
export const PAGE_CSP = [
  "default-src 'self' data: blob:",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDNS}`,
  `style-src 'self' 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src 'self' data: ${CDNS} https://fonts.gstatic.com`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  `connect-src 'self' data: blob: ${CDNS}`,
  "worker-src 'self' blob:",
  "frame-src 'self'",
].join("; ");
