/* Viewport-relative HUD coordinates. Shared by isolated content scripts and worker. */
(() => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const unit = n => finite(n) ? Math.max(0, Math.min(1, n)) : 1;
  const defaults = () => ({schemaVersion:1,collapsed:false,position:{x:1,y:1}});
  function sanitize(value) {
    return {schemaVersion:1,collapsed:value?.collapsed === true,position:{x:unit(value?.position?.x),y:unit(value?.position?.y)}};
  }
  function bounds(size, viewport) {
    const vw=Math.max(0,viewport.width||0),vh=Math.max(0,viewport.height||0);
    const left=Math.min(12,Math.max(0,(vw-size.width)/2)),top=Math.min(12,Math.max(0,(vh-size.height)/2));
    return {left,top,right:Math.max(left,vw-size.width-left),bottom:Math.max(top,vh-size.height-top)};
  }
  function clamp(point,size,viewport) {
    const b=bounds(size,viewport);
    return {x:Math.max(b.left,Math.min(b.right,finite(point.x)?point.x:b.left)),y:Math.max(b.top,Math.min(b.bottom,finite(point.y)?point.y:b.top))};
  }
  function position(saved,size,viewport) {
    const b=bounds(size,viewport);return {x:b.left+(b.right-b.left)*unit(saved?.x),y:b.top+(b.bottom-b.top)*unit(saved?.y)};
  }
  function normalize(point,size,viewport) {
    const b=bounds(size,viewport),p=clamp(point,size,viewport);
    return {x:b.right===b.left?1:(p.x-b.left)/(b.right-b.left),y:b.bottom===b.top?1:(p.y-b.top)/(b.bottom-b.top)};
  }
  globalThis.ArenaHudLayout={defaults,sanitize,bounds,clamp,position,normalize};
})();
