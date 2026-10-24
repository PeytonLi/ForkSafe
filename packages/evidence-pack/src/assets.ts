/** Inline stylesheet and replay player. Kept as constant strings so their
 *  CSP hashes are stable and the pack needs no network. */

export const STYLE = `
:root{--bg:#fbf8f3;--card:#fffdf9;--ink:#2b2620;--muted:#6f655a;--line:#e7dfd3;--blue:#2f6db3;--green:#2e7d4f;--amber:#a86a12;--red:#b23a2e;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.45rem;line-height:1.25;margin:.2rem 0 .4rem}
h2{font-size:1.1rem;margin:0 0 .6rem}
h3{font-size:1rem;margin:1rem 0 .4rem}
p{margin:.3rem 0}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.mono,code{font-family:var(--mono);font-size:.85em;overflow-wrap:anywhere;word-break:break-all}
.eyebrow{text-transform:uppercase;letter-spacing:.06em;font-size:.75rem;color:var(--muted);margin:0}
.banner{border-radius:10px;padding:10px 14px;margin:10px 0;border:1px solid}
.banner strong{display:block}
.mode-live{background:#eaf5ee;border-color:#b9dcc6;color:#1f5a37}
.mode-local{background:#eaf1fa;border-color:#bcd2ec;color:#204e82}
.mode-fixture,.mode-blocked,.mode-not_implemented{background:#fdf3e2;border-color:#ecd3a5;color:#6e4507}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:.8rem;background:#fff}
.badge{display:inline-block;border-radius:6px;padding:1px 8px;font-size:.8rem;font-weight:600;border:1px solid}
.s-passed,.s-passed_all,.s-approved,.s-candidate_passed,.s-succeeded{color:var(--green);border-color:#b9dcc6;background:#eaf5ee}
.s-failed,.s-no_passing_candidate,.s-rejected,.s-physics_failure,.s-constraint_violation{color:var(--red);border-color:#ebc0ba;background:#fbecea}
.s-invalid,.s-engine_error{color:var(--red);border-color:#ebc0ba;background:#fff}
.s-pending,.s-public_only,.s-not_evaluated,.s-evaluation_incomplete,.s-needs_changes,.s-queued,.s-running,.s-no_candidates,.s-hidden{color:var(--amber);border-color:#ecd3a5;background:#fdf3e2}
.verdict{font-size:1.15rem;font-weight:600;margin:.4rem 0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
dl.kv{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:4px 12px;margin:0}
dl.kv dt{color:var(--muted)}
dl.kv dd{margin:0;min-width:0}
table{width:100%;border-collapse:collapse;font-size:.88rem;table-layout:fixed}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{color:var(--muted);font-weight:600;font-size:.8rem}
.c-case{width:34%}.c-status{width:18%}.c-time{width:14%}
.diff{margin:8px 0 0;padding:10px 0;background:#fcfaf6;border:1px solid var(--line);border-radius:8px;font:12.5px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.d-l{display:block;padding:0 10px}
.d-sign{display:inline-block;width:1.2em;color:var(--muted);user-select:none}
.d-add{background:#e8f4ec}.d-del{background:#fbeceb}
.d-file{color:var(--muted)}.d-hunk{color:var(--blue);background:#eef3fa}.d-meta{color:var(--muted);font-style:italic}
.t-k{color:#8a3b8f;font-weight:600}.t-s{color:#2e7d4f}.t-n{color:#a3540c}.t-c{color:#80766a;font-style:italic}.t-f{color:#2f6db3}
.rationale{border-left:3px solid var(--line);padding:4px 10px;margin:8px 0;color:var(--muted)}
.player canvas{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:8px;background:#fff;aspect-ratio:16/9}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.controls input[type=range]{flex:1 1 160px;min-width:0}
button,select{font:inherit;border:1px solid var(--line);background:#fff;border-radius:8px;padding:4px 12px;color:var(--ink)}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:.8rem;color:var(--muted);margin:0;padding:0;list-style:none}
ul.plain{list-style:none;margin:0;padding:0}
ul.plain>li{border-top:1px solid var(--line);padding:8px 0}
ul.plain>li:first-child{border-top:0}
details summary{cursor:pointer;font-weight:600}
pre.json{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 var(--mono);max-height:360px;overflow:auto;background:#fcfaf6;border:1px solid var(--line);border-radius:8px;padding:10px}
.warn li{color:var(--amber)}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin-top:20px}
@media (max-width:480px){main{padding:14px 10px 32px}section{padding:12px}.c-exp{display:none}dl.kv{grid-template-columns:1fr}dl.kv dt{margin-top:4px}}
@media print{body{background:#fff;font-size:11pt}main{max-width:none;padding:0}section{break-inside:avoid;border-color:#ccc}.controls,.noprint{display:none}pre.json{max-height:none}.diff{break-inside:auto}a{color:inherit}}
`;

export const PLAYER = `(function(){
"use strict";
var el=document.getElementById("fs-bundle");if(!el)return;
var data;try{data=JSON.parse(el.textContent||"")}catch(e){return}
var replays=(data.bundle&&data.bundle.replays)||[];
var scenes=data.pack&&data.pack.replayScenes||{};
var root=document.getElementById("fs-player");if(!root||!replays.length)return;
var canvas=root.querySelector("canvas"),ctx=canvas.getContext("2d");
var sel=root.querySelector("select"),btn=root.querySelector("button"),range=root.querySelector("input[type=range]"),out=root.querySelector("output");
var cur=0,idx=0,timer=null;
function frames(){return replays[cur].frames||[]}
function pos(f,name){for(var i=0;i<f.bodies.length;i++){if(f.bodies[i].name===name)return f.bodies[i].pos}return null}
function bounds(){var fr=frames(),y0=1e9,y1=-1e9,x0=1e9,x1=-1e9,z1=0.2;
for(var i=0;i<fr.length;i++){var b=fr[i].bodies;for(var j=0;j<b.length;j++){var p=b[j].pos;if(p[0]<x0)x0=p[0];if(p[0]>x1)x1=p[0];if(p[1]<y0)y0=p[1];if(p[1]>y1)y1=p[1];if(p[2]>z1)z1=p[2]}}
var sc=scenes[replays[cur].artifactId];if(sc&&sc.divider){x0=Math.min(x0,sc.divider.x-sc.divider.len/2);x1=Math.max(x1,sc.divider.x+sc.divider.len/2);z1=Math.max(z1,sc.divider.h)}
var m=0.06;return{y0:y0-m,y1:y1+m,x0:x0-m,x1:x1+m,z0:0,z1:z1+m}}
var B=null;
function size(){var w=canvas.clientWidth||640,r=window.devicePixelRatio||1;canvas.width=Math.round(w*r);canvas.height=Math.round(w*9/16*r);ctx.setTransform(r,0,0,r,0,0)}
function draw(){var fr=frames();if(!fr.length)return;var f=fr[idx],w=canvas.clientWidth||640,h=w*9/16,pad=10,half=(w-pad*3)/2;
ctx.clearRect(0,0,w,h);ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
var panels=[{ox:pad,lbl:"Top view (y \\u2192, x \\u2191)",u:1,v:0,v0:B.x0,v1:B.x1},{ox:pad*2+half,lbl:"Side view (y \\u2192, z \\u2191)",u:1,v:2,v0:B.z0,v1:B.z1}];
var sc=scenes[replays[cur].artifactId];
panels.forEach(function(P){var top=26,ph=h-top-pad,s=Math.min(half/(B.y1-B.y0),ph/(P.v1-P.v0));
function X(p){return P.ox+(p[P.u]-B.y0)*s}function Y(p){return top+ph-(p[P.v]-P.v0)*s}
ctx.strokeStyle="#e7dfd3";ctx.strokeRect(P.ox,top,half,ph);ctx.fillStyle="#6f655a";ctx.font="12px system-ui,sans-serif";ctx.fillText(P.lbl,P.ox+4,top-8);
if(P.v===2){ctx.strokeStyle="#cdbfae";ctx.beginPath();ctx.moveTo(P.ox,Y([0,0,0]));ctx.lineTo(P.ox+half,Y([0,0,0]));ctx.stroke()}
var tg=pos(f,"target");if(tg){ctx.strokeStyle="#2e7d4f";ctx.setLineDash([4,3]);ctx.beginPath();ctx.arc(X(tg),Y(tg),0.03*s,0,6.283);ctx.stroke();ctx.setLineDash([])}
var dv=pos(f,"divider");if(dv){ctx.fillStyle="rgba(120,104,88,.55)";var t=0.012;
if(sc&&sc.divider){var d=sc.divider;if(P.v===0){ctx.fillRect(X([0,d.y-t/2,0]),Y([d.x+d.len/2,0,0]),t*s,d.len*s)}else{ctx.fillRect(X([0,d.y-t/2,0]),Y([0,0,d.h]),t*s,d.h*s)}}
else{ctx.fillRect(X(dv)-3,Y(dv)-3,6,6)}}
var arm=f.bodies.filter(function(b){return b.name!=="cube"&&b.name!=="divider"&&b.name!=="target"});
ctx.strokeStyle="#2f6db3";ctx.lineWidth=3;ctx.lineJoin="round";ctx.beginPath();arm.forEach(function(b,i){var p=b.pos;if(i)ctx.lineTo(X(p),Y(p));else ctx.moveTo(X(p),Y(p))});ctx.stroke();ctx.lineWidth=1;
arm.forEach(function(b){ctx.fillStyle="#2f6db3";ctx.beginPath();ctx.arc(X(b.pos),Y(b.pos),2.5,0,6.283);ctx.fill()});
var cb=pos(f,"cube");if(cb){var c=0.05*s;ctx.fillStyle=f.attached?"#d08b2c":"#a86a12";ctx.fillRect(X(cb)-c/2,Y(cb)-c/2,c,c)}
if(f.contacts&&f.contacts.length){ctx.strokeStyle="#b23a2e";ctx.lineWidth=2;f.contacts.forEach(function(k){var a=pos(f,k.a);if(a){ctx.beginPath();ctx.arc(X(a),Y(a),9,0,6.283);ctx.stroke()}});ctx.lineWidth=1}
});
var r=replays[cur],last=fr[fr.length-1].tSec;var txt="t = "+f.tSec.toFixed(2)+" s / "+last.toFixed(2)+" s";
if(f.contacts&&f.contacts.length){txt+=" \\u2014 contact: "+f.contacts.map(function(k){return k.a+"\\u2194"+k.b}).join(", ")}
out.textContent=txt;range.value=String(idx)}
function load(i){cur=i;idx=0;var fr=frames();range.max=String(Math.max(0,fr.length-1));B=bounds();stop();draw()}
function stop(){if(timer){clearInterval(timer);timer=null}btn.textContent="Play";btn.setAttribute("aria-pressed","false")}
function play(){if(timer){stop();return}var fr=frames();if(idx>=fr.length-1)idx=0;btn.textContent="Pause";btn.setAttribute("aria-pressed","true");
var dt=fr.length>1?Math.max(30,Math.min(200,(fr[1].tSec-fr[0].tSec)*1000)):100;
timer=setInterval(function(){if(idx>=frames().length-1){stop();return}idx++;draw()},dt)}
btn.addEventListener("click",play);
range.addEventListener("input",function(){stop();idx=Number(range.value)||0;draw()});
sel.addEventListener("change",function(){load(Number(sel.value)||0)});
canvas.addEventListener("keydown",function(e){var n=frames().length;if(e.key==="ArrowRight"){idx=Math.min(n-1,idx+1);stop();draw();e.preventDefault()}else if(e.key==="ArrowLeft"){idx=Math.max(0,idx-1);stop();draw();e.preventDefault()}else if(e.key===" "){play();e.preventDefault()}});
window.addEventListener("resize",function(){size();draw()});
root.hidden=false;var nojs=document.getElementById("fs-player-nojs");if(nojs)nojs.hidden=true;
size();load(0);
var fr0=frames(),ff=replays[0].firstFailure;if(ff){for(var i=0;i<fr0.length;i++){if(fr0[i].tSec>=ff.tSec){idx=i;break}}draw()}
})();`;
