/* Bounded read scheduler. Never posts a vote or a chat message. */
(() => {
  function create({read,setTimer=setTimeout,clearTimer=clearTimeout}){
    let current=null,generation=0,timer=null,busy=false,pending=null,closed=false;
    const cancelTimer=()=>{if(timer!==null)clearTimer(timer);timer=null;};
    function schedule(reason,attempt=0,delay=0){cancelTimer();const ticket=generation;timer=setTimer(()=>{timer=null;if(ticket===generation)void execute(reason,attempt,ticket);},delay);}
    async function execute(reason,attempt,ticket){
      if(closed||!current||ticket!==generation)return;
      if(busy){pending=reason;return;}
      busy=true;let result;
      try{result=await read({automatic:reason!=='manual',reason,sessionId:current});}catch{result={status:'error'};}
      if(ticket!==generation)return;
      busy=false;
      if(result?.status==='error'||result?.status==='stale'){pending=null;return;}
      if(pending){const next=pending;pending=null;schedule(next,0,400);return;}
      const retry=result?.status==='unsupported'||(reason==='vote'&&result?.status==='unrevealed');
      // At most three reads; never retry HTTP/network/storage errors automatically.
      if(retry&&attempt<2)schedule(reason,attempt+1,[1000,2500][attempt]);
    }
    return {
      enter(sessionId){if(current===sessionId)return;generation++;cancelTimer();current=sessionId;busy=false;pending=null;if(current)schedule('enter',0,500);},
      trigger(reason='vote'){if(closed||!current)return;if(busy){pending=reason;return;}schedule(reason,0,500);},
      async manual(){cancelTimer();if(closed||!current||busy)return;return execute('manual',0,generation);},
      close(){closed=true;generation++;cancelTimer();current=null;busy=false;pending=null;},
      state:()=>({sessionId:current,busy,scheduled:timer!==null})
    };
  }
  globalThis.ArenaBattleAuto={create};
})();
