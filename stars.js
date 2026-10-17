/* A perspective starfield inspired by the front of the Superfast name card.
   No libraries, cookies, trackers, or network calls. */
(() => {
  'use strict';
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d', {alpha:false});
  if (!ctx) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let width=0, height=0, depth=1600, focus=1, stars=[], frame=0, last=0;
  function star(initial) {
    return {x:(Math.random()-.5)*width*depth/focus*1.32,
      y:(Math.random()-.5)*height*depth/focus*1.32,
      z:initial ? 30+Math.random()*(depth-30) : depth,
      blue:Math.random()<.18, weight:.4+Math.random()*.8};
  }
  function resize() {
    width=innerWidth; height=innerHeight;
    const scale=Math.min(devicePixelRatio||1,1.75);
    canvas.width=Math.round(width*scale); canvas.height=Math.round(height*scale);
    ctx.setTransform(scale,0,0,scale,0,0);
    focus=Math.max(width,height)*.78;
    stars=Array.from({length:width<600?560:1050},()=>star(true));
    if (reduced.matches) draw(0);
  }
  function draw(elapsed) {
    ctx.fillStyle='#050609'; ctx.fillRect(0,0,width,height);
    const cx=width/2,cy=height/2;
    for (let i=0;i<stars.length;i++) {
      const s=stars[i]; s.z-=elapsed*170;
      const x=cx+s.x*focus/s.z,y=cy+s.y*focus/s.z;
      if (s.z<8||x< -80||x>width+80||y< -80||y>height+80) {stars[i]=star(false);continue;}
      const tail=s.z+11+38*(1-s.z/depth);
      const px=cx+s.x*focus/tail,py=cy+s.y*focus/tail;
      const alpha=Math.min(.94,.12+(1-s.z/depth)*.78);
      ctx.strokeStyle=s.blue?`rgba(113,135,255,${alpha})`:`rgba(238,235,221,${alpha*.82})`;
      ctx.lineWidth=Math.max(.45,s.weight*(1.5-s.z/depth));
      ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(x,y);ctx.stroke();
      if(s.blue&&s.z<430){ctx.strokeStyle=`rgba(113,135,255,${alpha*.1})`;ctx.lineWidth=5;ctx.stroke();}
    }
  }
  function tick(now) {
    draw(last?Math.min((now-last)/1000,.05):0);last=now;
    frame=requestAnimationFrame(tick);
  }
  function motion() {
    cancelAnimationFrame(frame);last=0;
    if(reduced.matches||document.hidden)draw(0);
    else frame=requestAnimationFrame(tick);
  }
  addEventListener('resize',resize,{passive:true});
  document.addEventListener('visibilitychange',motion);
  reduced.addEventListener('change',motion);
  resize();motion();
})();
