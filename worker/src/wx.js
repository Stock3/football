// АВТОМАТИЧНА КОПІЯ блоку WX з index.html — не редагувати тут. Оновити: node worker/sync.mjs
export const WX = (/*WX*/function(){
  var MODELS=[["ecmwf_ifs025","ECMWF"],["gfs_seamless","GFS"],["icon_seamless","ICON"]];
  var VARS=["temperature_2m","apparent_temperature","precipitation_probability","precipitation","wind_speed_10m","weather_code"];
  var DAYS=["Неділя","Понеділок","Вівторок","Середа","Четвер","Пʼятниця","Субота"];
  var MON=["січня","лютого","березня","квітня","травня","червня","липня","серпня","вересня","жовтня","листопада","грудня"];
  function url(s,base){
    return (base||"https://api.open-meteo.com")+"/v1/forecast?latitude="+encodeURIComponent(s.lat)+"&longitude="+encodeURIComponent(s.lon)+
      "&models="+MODELS.map(function(m){return m[0];}).join(",")+"&hourly="+VARS.join(",")+"&wind_speed_unit=ms&timezone=Europe%2FKyiv&forecast_days=10";
  }
  function num(v){return typeof v==="number"&&isFinite(v)?v:null;}
  function med(a){a=a.filter(function(v){return v!=null;}).sort(function(x,y){return x-y;});return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):null;}
  function hh2(n){return ("0"+n).slice(-2)+":00";}
  /* json — відповідь Open-Meteo; date — "YYYY-MM-DD"; time — час гри "HH:MM";
     warn — поріг «Погода під питанням», %; dry — поріг «сухо» (усі моделі нижче), % */
  function build(json,date,time,warn,dry){
    var h=(json&&json.hourly)||{}, t=h.time||[], hh=+(/^(\d{1,2})/.exec(time||"")||[0,21])[1], at=date+"T"+hh2(hh);
    var gi=t.indexOf(at), di=[];
    /* «вдень» — з 08:00 до години перед грою */
    t.forEach(function(x,i){var hr=+x.slice(11,13); if(x.slice(0,10)===date&&hr>=8&&hr<hh)di.push(i);});
    var models=MODELS.map(function(m){
      function v(k,i){var a=h[k+"_"+m[0]];return a&&i>=0?num(a[i]):null;}
      var r={name:m[1],ok:gi>=0&&v("temperature_2m",gi)!=null};
      if(!r.ok)return r;
      r.at={code:v("weather_code",gi),t:v("temperature_2m",gi),app:v("apparent_temperature",gi),pp:v("precipitation_probability",gi),wind:v("wind_speed_10m",gi)};
      var day={t:[],pp:[],mm:0,wind:[]};
      di.forEach(function(i){var x;if((x=v("temperature_2m",i))!=null)day.t.push(x);if((x=v("precipitation_probability",i))!=null)day.pp.push(x);if((x=v("precipitation",i))!=null)day.mm+=x;if((x=v("wind_speed_10m",i))!=null)day.wind.push(x);});
      r.day=day; return r;
    });
    var ok=models.filter(function(m){return m.ok;}), all=function(k){var o=[];ok.forEach(function(m){o=o.concat(m.day[k]);});return o;};
    var T=all("t"), P=all("pp"), Wd=all("wind");
    var day=ok.length&&T.length?{tmin:Math.min.apply(null,T),tmax:Math.max.apply(null,T),pp:P.length?Math.max.apply(null,P):null,
      mm:Math.max.apply(null,ok.map(function(m){return m.day.mm;})),wind:Wd.length?Math.max.apply(null,Wd):null}:null;
    /* більшість моделей з даними: 2 з 3, з 2 — обидві */
    var pv=ok.map(function(m){return m.at.pp;}).filter(function(v){return v!=null;}), votes=pv.filter(function(v){return v>=(+warn||90);}).length;
    var byPp=ok.slice().sort(function(a,b){return (a.at.pp||0)-(b.at.pp||0);}), mid=byPp[Math.floor((byPp.length-1)/2)];
    var isWarn=pv.length>0&&votes>pv.length/2, dryN=dry==null||dry===""?40:+dry;
    /* вердикт на годину гри: warn — більшість моделей ≥ warn; dry — усі < dry; інакше rain */
    var verdict=!pv.length?null:isWarn?"warn":pv.every(function(v){return v<dryN;})?"dry":"rain";
    return {date:date,time:hh2(hh),from:"08:00",to:hh2(Math.max(8,hh-1)),models:models,day:day,any:ok.length>0,warn:isWarn,verdict:verdict,
      med:ok.length?{code:mid.at.code,t:med(ok.map(function(m){return m.at.t;})),pp:med(pv),wind:med(ok.map(function(m){return m.at.wind;}))}:null};
  }
  function deg(v){if(v==null)return "?°";v=Math.round(v);return (v>0?"+":v<0?"−":"")+Math.abs(v)+"°";}
  function pct(v){return v==null?"—%":Math.round(v)+"%";}
  function ms(v){return v==null?"? м/с":Math.round(v)+" м/с";}
  function mm(v){return String(Math.round(v*10)/10).replace(".",",");}
  function icon(c,hour){
    var night=hour>=19||hour<6;
    if(c==null)return "❔"; if(c===0)return night?"🌙":"☀️"; if(c<=2)return night?"☁️":"🌤"; if(c===3)return "☁️"; if(c===45||c===48)return "🌫";
    if(c>=51&&c<=57)return "🌦"; if((c>=61&&c<=67)||(c>=80&&c<=82))return "🌧"; if((c>=71&&c<=77)||c===85||c===86)return "🌨"; if(c>=95)return "⛈"; return "🌥";
  }
  function head(r,city){var d=new Date(r.date+"T00:00:00Z");return "🌦 "+DAYS[d.getUTCDay()]+", "+d.getUTCDate()+" "+MON[d.getUTCMonth()]+(city?" · "+city:"");}
  function dayLine(r){
    var d=r.day, lbl="Вдень ("+r.from+"–"+r.to+"): "; if(!d)return lbl+"немає прогнозу";
    var rain=(d.pp==null&&d.mm<0.05)||(d.pp===0&&d.mm<0.05)?"без опадів":(d.tmin<=0?"опади":"дощ")+" до "+pct(d.pp)+" ("+mm(d.mm)+" мм)";
    return lbl+deg(d.tmin).replace("°","")+"…"+deg(d.tmax)+", "+rain+", вітер до "+ms(d.wind);
  }
  function gameHead(r){return "⚽ На гру, "+r.time+":";}
  /* v — тексти {dry,rain,warn} з налаштувань */
  function verdictText(r,v){
    v=v||{}; var d={dry:"✅ Схоже, зіграємо сухими",rain:"☔ Можливий дощ",warn:"⚠️ Погода під питанням"};
    return r.verdict?(v[r.verdict]||d[r.verdict]):"";
  }
  function modelLine(m,hour,pad){
    var n=pad?(m.name+"     ").slice(0,5)+" ":m.name+" ";
    if(!m.ok)return n+"немає прогнозу";
    return n+icon(m.at.code,hour)+" "+deg(m.at.t)+" (відч. "+deg(m.at.app)+") · "+pct(m.at.pp)+" · "+ms(m.at.wind);
  }
  /* Погодинний вигляд (лише бот): 10:00–23:00 дати гри, по рядку на годину. Значення години — медіана доступних моделей
     (не середнє, щоб один викид не тягнув решту); ймовірність опадів у Open-Meteo є для кожної з 3 моделей окремо.
     ⚠️ — моделі розходяться: одна суха, інша з опадами (≥ WET_MM), або розкид опадів ≥ SPREAD_MM. */
  var H_FROM=10,H_TO=23,WET_MM=0.2,SPREAD_MM=1;
  function medCode(a){a=a.filter(function(v){return v!=null;}).sort(function(x,y){return x-y;});return a.length?a[Math.floor(a.length/2)]:null;}
  function pad(s,n){s=String(s);while(s.length<n)s=" "+s;return s;}
  function rainy(r){return r.mm!=null&&r.mm>=WET_MM;}
  function hourIcon(r){
    var c=r.code; if(rainy(r)&&(c==null||c<51))c=r.t!=null&&r.t<=0?71:61; /* опади є, а код «без опадів» — довіряємо опадам */
    return icon(c,r.hour);
  }
  function hourLine(r){
    var t=r.t==null?"?°":(Math.round(r.t)<0?"−":"")+Math.abs(Math.round(r.t))+"°";
    return pad(r.hour,2)+" "+hourIcon(r)+" "+pad(t,3)+" "+pad(r.mm==null?"—":r.mm.toFixed(1),3)+" мм "+pad(r.pp==null?"—":Math.round(r.pp),3)+"%"+(r.warn?" ⚠️":"");
  }
  /* json — відповідь Open-Meteo; date — "YYYY-MM-DD"; time — час гри "HH:MM" (для «поле може бути мокре»: опади до гри) */
  function hourly(json,date,time){
    var h=(json&&json.hourly)||{}, t=h.time||[], gh=+(/^(\d{1,2})/.exec(time||"")||[0,21])[1], all=[];
    t.forEach(function(x,i){
      if(x.slice(0,10)!==date)return;
      var T=[],P=[],R=[],C=[];
      MODELS.forEach(function(m){
        function v(k){var a=h[k+"_"+m[0]];return a?num(a[i]):null;}
        var x1=v("temperature_2m"); if(x1==null)return; /* модель без даних на цю годину пропускаємо */
        T.push(x1);
        if((x1=v("precipitation_probability"))!=null)P.push(x1);
        if((x1=v("precipitation"))!=null)R.push(x1);
        if((x1=v("weather_code"))!=null)C.push(x1);
      });
      if(!T.length)return;
      var wet=R.filter(function(v){return v>=WET_MM;}).length;
      all.push({hour:+x.slice(11,13),n:T.length,t:med(T),pp:med(P),mm:med(R),code:medCode(C),
        warn:R.length>1&&((wet>0&&wet<R.length)||Math.max.apply(null,R)-Math.min.apply(null,R)>=SPREAD_MM)});
    });
    var rows=all.filter(function(r){return r.hour>=H_FROM&&r.hour<=H_TO;}), spans=[];
    rows.filter(rainy).forEach(function(r){var l=spans[spans.length-1];if(l&&l[1]===r.hour-1)l[1]=r.hour;else spans.push([r.hour,r.hour]);});
    var wetField=all.some(function(r){return r.hour<gh&&rainy(r);});
    var sum=(spans.length?"🌧 Опади: "+spans.map(function(s){return s[0]===s[1]?""+s[0]:s[0]+"–"+s[1];}).join(", ")+" год":wetField?"✅ Опадів з "+H_FROM+":00 немає":"✅ Без опадів")+(wetField?" · поле може бути мокре":"");
    return {date:date,rows:rows,summary:rows.length?sum:"",lines:rows.map(hourLine),anyWarn:rows.some(function(r){return r.warn;}),wetField:wetField};
  }
  /* повний текст (старий вигляд: бот його більше не шле, лишився для сумісності) */
  function text(r,o){
    var hour=+r.time.slice(0,2), L=[head(r,o.city),dayLine(r),"",gameHead(r)], v=verdictText(r,o.verdicts);
    r.models.forEach(function(m){L.push(modelLine(m,hour,true));});
    if(v)L.push("",v);
    return L.join("\n");
  }
  /* один рядок (картка гри): медіана моделей */
  function line(r){
    var m=r.med; if(!m)return "";
    return icon(m.code,+r.time.slice(0,2))+" "+deg(m.t)+" · "+pct(m.pp)+" · "+ms(m.wind)+" о "+r.time+(r.warn?" ⚠️":"");
  }
  return {url:url,build:build,text:text,line:line,head:head,dayLine:dayLine,gameHead:gameHead,verdictText:verdictText,modelLine:modelLine,icon:icon,hourly:hourly};
}/*/WX*/)();
