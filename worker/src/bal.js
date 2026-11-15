// АВТОМАТИЧНА КОПІЯ блоку BAL з index.html — не редагувати тут. Оновити: node worker/sync.mjs
export const BAL = (/*BAL*/function(){
  /* x — скасована гра; без рахунку — запланована */
  function played(g){return !!g&&!g.x&&g.sy!=null&&g.sb!=null&&g.sy!==""&&g.sb!=="";}
  function isNum(x){return x!=null&&x!==""&&isFinite(+x);}
  function r2(n){return Math.round(n*100)/100;}
  /* ціна гри: знімок g.pr (ставиться, коли вносять рахунок), інакше поточна settings.price */
  function charge(g,s){return isNum(g&&g.pr)?+g.pr:isNum(s&&s.price)?+s.price:0;}
  /* за гру списується: зіграна, не скасована, з датою не раніше початку обліку (порожній payFrom — облік вимкнено) */
  function charged(g,s){return !!(s&&s.payFrom)&&played(g)&&g.date>=s.payFrom;}
  /* хто платить: усі гравці команд, і організатор теж; гості (gy/gb) — ні */
  function inGame(g,pid){return (g.y||[]).indexOf(pid)>=0||(g.b||[]).indexOf(pid)>=0;}
  function tops(p){return (p&&Array.isArray(p.top)?p.top:[]).filter(function(t){return t&&isNum(t.a)&&/^\d{4}-\d{2}-\d{2}$/.test(String(t.d||""));});}
  function player(data,pid){var ps=(data&&data.players)||[];for(var i=0;i<ps.length;i++)if(ps[i].id===pid)return ps[i];return null;}
  /* історія гравця від старого до нового: {k:"top",id,d,a,n?} і {k:"game",id,d,a:−ціна}; b — баланс після запису.
     Того ж дня поповнення йде перед списанням. */
  function history(data,s,pid){
    var L=[];
    tops(player(data,pid)).forEach(function(t,i){L.push({k:"top",id:t.id||"",d:t.d,a:+t.a,n:t.n||"",i:i});});
    ((data&&data.games)||[]).forEach(function(g,i){if(charged(g,s)&&inGame(g,pid))L.push({k:"game",id:g.id,d:g.date,a:-charge(g,s),i:i});});
    L.sort(function(x,y){return x.d<y.d?-1:x.d>y.d?1:x.k!==y.k?(x.k==="top"?-1:1):x.i-y.i;});
    var b=0; L.forEach(function(e){b=r2(b+e.a);e.b=b;delete e.i;});
    return L;
  }
  /* підсумок гравця: bal — баланс; lastTop — останнє поповнення; lastGame — остання списана гра {id,d,a>0} */
  function info(data,s,pid){
    var h=history(data,s,pid), lt=null, lg=null;
    h.forEach(function(e){if(e.k==="top")lt=e;else lg=e;});
    return {bal:h.length?h[h.length-1].b:0,hist:h,lastTop:lt,lastGame:lg?{id:lg.id,d:lg.d,a:-lg.a}:null};
  }
  function balance(data,s,pid){return info(data,s,pid).bal;}
  /* 81 → "81", -40.5 → "-40,5" */
  function fmt(n){var v=r2(+n||0);return String(v).replace(".",",");}
  /* старі тексти моделі «борг за гру» (до балансу) не підходять — замість них стандартні */
  function legacy(t){return /\{(debt|sum|card|cardName|bank)\}|\/status\b/.test(String(t||""));}
  return {played:played,charge:charge,charged:charged,inGame:inGame,tops:tops,history:history,info:info,balance:balance,fmt:fmt,legacy:legacy};
}/*/BAL*/)();
