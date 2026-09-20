import './hud-layout.js';
export const HUD_PREF_KEY='ati.ui.hud.v1';
export function createHudPreferences(area,ready=Promise.resolve(true)) {
  let queue=Promise.resolve();
  async function read(){if(!await ready)throw Error('storage unavailable');return ArenaHudLayout.sanitize((await area.get(HUD_PREF_KEY))[HUD_PREF_KEY]);}
  return {
    async get(){await queue;return read();},
    save(input){
      const work=queue.then(async()=>{
        const current=await read();
        const next=ArenaHudLayout.sanitize({collapsed:typeof input?.collapsed==='boolean'?input.collapsed:current.collapsed,position:input?.position||current.position});
        await area.set({[HUD_PREF_KEY]:next});return next;
      });
      queue=work.catch(()=>{});return work;
    }
  };
}
