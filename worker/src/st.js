// АВТОМАТИЧНА КОПІЯ блоку ST з index.html — не редагувати тут. Оновити: node worker/sync.mjs
export const ST = (/*ST*/function(){
  var MS=[10,25,50,75,100,150,200,250,300,400,500];
  /* x — скасована гра: не йде ні в статистику, ні в оплату */
  function played(g){return !!g&&!g.x&&g.sy!=null&&g.sb!=null&&g.sy!==""&&g.sb!=="";}
  function onTeam(g,id){return (g.y||[]).indexOf(id)>=0?"y":(g.b||[]).indexOf(id)>=0?"b":null;}
  function sorted(list){return list.slice().sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0;});}
  /* результат гри для сторони: my/op — голи, r — w|l|d */
  function res(g,side){var my=side==="y"?+g.sy:+g.sb, op=side==="y"?+g.sb:+g.sy;return {my:my,op:op,r:my>op?"w":my<op?"l":"d"};}
  function pts(x){return x.w*3+x.d;}
  /* поріг для рейтингу за %В і +/− */
  function minGames(n){return Math.max(3,Math.round(n*0.2));}
  function nextMs(v){for(var i=0;i<MS.length;i++)if(MS[i]>v)return MS[i];return Math.ceil((v+1)/100)*100;}
  /* сезони — роки з дат ігор; за замовчуванням — останній рік із зіграною грою (запланована гра наступного року не відкриває порожній сезон) */
  function years(games){var y={};(games||[]).forEach(function(g){y[String(g.date).slice(0,4)]=1;});return Object.keys(y).sort();}
  function defSeason(games){var pl=years((games||[]).filter(played)), ys=years(games);return pl.length?pl[pl.length-1]:ys.length?ys[ys.length-1]:"all";}
  function inSeason(g,season){return season==="all"||String(g.date).slice(0,4)===season;}
  /* зіграні ігри періоду за датою */
  function period(games,season){return sorted((games||[]).filter(function(g){return played(g)&&inSeason(g,season);}));}

  /* games — зіграні ігри за датою. players[id]: g,w,d,l,gf,ga,seq (w|l|d за порядком),months{YYYY-MM:n},t{y,b},pct,gd,att,bestStreak,cur{r,n}; pairs — пари однієї команди */
  function stats(games){
    var st={}, pairs={};
    function P(id){return st[id]||(st[id]={id:id,g:0,w:0,d:0,l:0,gf:0,ga:0,seq:[],months:{},t:{y:{g:0,w:0,d:0,l:0},b:{g:0,w:0,d:0,l:0}}});}
    games.forEach(function(g){
      [["y",+g.sy,+g.sb],["b",+g.sb,+g.sy]].forEach(function(t){
        var ids=g[t[0]]||[], my=t[1], op=t[2], r=my>op?"w":my<op?"l":"d";
        ids.forEach(function(id){var p=P(id);p.g++;p[r]++;p.t[t[0]].g++;p.t[t[0]][r]++;p.gf+=my;p.ga+=op;p.seq.push(r);var m=g.date.slice(0,7);p.months[m]=(p.months[m]||0)+1;});
        for(var i=0;i<ids.length;i++)for(var j=i+1;j<ids.length;j++){
          var k=[ids[i],ids[j]].sort().join("|"); var q=pairs[k]||(pairs[k]={a:k.split("|")[0],b:k.split("|")[1],g:0,w:0,d:0});
          q.g++; if(r==="w")q.w++; if(r==="d")q.d++;
        }
      });
    });
    Object.keys(st).forEach(function(id){
      var p=st[id]; p.pct=p.w/p.g; p.gd=(p.gf-p.ga)/p.g; p.att=games.length?p.g/games.length:0;
      var best=0,run=0; p.seq.forEach(function(r){run=r==="w"?run+1:0; if(run>best)best=run;}); p.bestStreak=best;
      var cur=0,last=p.seq[p.seq.length-1]; for(var i=p.seq.length-1;i>=0&&p.seq[i]===last;i--)cur++; p.cur={r:last,n:cur};
    });
    return {players:st,pairs:pairs};
  }
  /* місце за очками (серед усіх) і за %В (серед тих, хто зіграв ≥ minGames; rp null — замало ігор) */
  function rank(data,id,n){
    var s=data.players[id], rows=Object.keys(data.players).map(function(k){return data.players[k];});
    var rk=1+rows.filter(function(x){return pts(x)>pts(s);}).length;
    var mg=minGames(n), el=rows.filter(function(x){return x.g>=mg;}), rp=s.g>=mg?1+el.filter(function(x){return x.pct>s.pct;}).length:null;
    return {rk:rk,of:rows.length,rp:rp,el:el.length,mg:mg};
  }
  /* з ким найкраще/найгірше разом (≥3 спільних ігор) */
  function mates(data,id){
    var list=[]; Object.keys(data.pairs).forEach(function(k){var q=data.pairs[k]; if(q.g>=3&&(q.a===id||q.b===id))list.push({id:q.a===id?q.b:q.a,g:q.g,w:q.w,pct:q.w/q.g});});
    list.sort(function(a,b){return b.pct-a.pct||b.g-a.g;});
    var best=list.slice(0,3), worst=list.slice(-3).reverse().filter(function(m){return best.indexOf(m)<0;});
    return {best:best,worst:worst};
  }
  /* суперники (≥3 ігор один проти одного) */
  function rivals(id,games){
    var m={};
    games.forEach(function(g){
      var side=onTeam(g,id); if(!side)return;
      var r=res(g,side).r;
      (g[side==="y"?"b":"y"]||[]).forEach(function(o){var q=m[o]||(m[o]={id:o,g:0,w:0,d:0,l:0});q.g++;q[r]++;});
    });
    return Object.keys(m).map(function(k){return m[k];}).filter(function(q){return q.g>=3;});
  }
  /* кого найчастіше обігрує / кому найчастіше програє (до 3) */
  function foes(rv){
    var beat=rv.slice().sort(function(a,b){return b.w/b.g-a.w/a.g||b.g-a.g;}).filter(function(q){return q.w>0;}).slice(0,3);
    var lose=rv.slice().sort(function(a,b){return b.l/b.g-a.l/a.g||b.g-a.g;}).filter(function(q){return q.l>0&&beat.indexOf(q)<0;}).slice(0,3);
    return {beat:beat,lose:lose};
  }
  /* останні n ігор гравця, від найновішої: {g,side,my,op,r,mates[ids],gu} */
  function last(games,id,n){
    return games.filter(function(g){return onTeam(g,id);}).slice(-n).reverse().map(function(g){
      var side=onTeam(g,id), x=res(g,side);
      return {g:g,side:side,my:x.my,op:x.op,r:x.r,mates:(g[side]||[]).filter(function(p){return p!==id;}),gu:+(side==="y"?g.gy:g.gb)||0};
    });
  }
  function first(games,id){for(var i=0;i<games.length;i++)if(onTeam(games[i],id))return games[i];return null;}
  /* усе для профілю гравця за період: car — за весь час (віхи), s — за період (null — не грав) */
  function profile(allGames,id,season,n){
    var all=period(allGames,"all"), games=season==="all"?all:period(allGames,season), car=stats(all).players[id]||null, data=stats(games), s=data.players[id]||null;
    var o={season:season,all:all,games:games,data:data,s:s,car:car,first:first(all,id),ms:car?{g:nextMs(car.g),w:nextMs(car.w)}:null};
    if(!s)return o;
    o.rank=rank(data,id,games.length); o.mates=mates(data,id); o.foes=foes(rivals(id,games)); o.last=last(games,id,n||10);
    return o;
  }
  return {MS:MS,played:played,onTeam:onTeam,sorted:sorted,res:res,pts:pts,minGames:minGames,nextMs:nextMs,years:years,defSeason:defSeason,inSeason:inSeason,period:period,
    stats:stats,rank:rank,mates:mates,rivals:rivals,foes:foes,last:last,first:first,profile:profile};
}/*/ST*/)();
