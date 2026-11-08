import * as fs from "node:fs";
import * as S from "./strategy.js";
const DICT = fs.readFileSync("../spacetimedb/wordlist.txt","utf8").split("\n").map(l=>l.trim().toUpperCase()).filter(l=>l.length>=2).sort((a,b)=>b.length-a.length);
const BAG="A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1";
const V=S.LETTER_VALUE;
const can=(w:string,r:Map<string,number>)=>{const u:any={};for(const c of w){u[c]=(u[c]??0)+1;if(u[c]>(r.get(c)??0))return false}return true};
const simBest=(r:Map<string,number>)=>{let b:string|null=null,br=0;for(const w of DICT){if(w.length<3)continue;if(can(w,r)){const x=S.wordReward(w);if(x>br){br=x;b=w}}}return b};
const take=(r:Map<string,number>,w:string)=>{for(const c of w)r.set(c,r.get(c)!-1)};
type P={kind:string,bal:number,score:number,rack:Map<string,number>,known:Map<string,number>};
const PA=JSON.parse(process.env.PA??"{}"),PB=JSON.parse(process.env.PB??"{}");
const prm=(k:string)=>k==="ours"?PA:PB;
function game(kinds:string[]){
  const bag:string[]=[];for(const[,l,n]of BAG.matchAll(/([A-Z])(\d+)/g))for(let i=0;i<+n;i++)bag.push(l);
  for(let i=bag.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]]}
  const ps:P[]=kinds.map(k=>({kind:k,bal:100,score:0,rack:new Map(),known:new Map()}));
  for(const p of ps)for(let i=0;i<5;i++){const l=bag.pop()!;p.rack.set(l,(p.rack.get(l)??0)+1)}
  const play=(p:P,w:string|null)=>{if(!w)return false;take(p.rack,w);for(const c of w)p.known.set(c,Math.max(0,(p.known.get(c)??0)-1));const r=S.wordReward(w);p.score+=r;p.bal+=r;return true};
  const botTurn=(p:P)=>{ if(p.kind==="ours"){for(let k=0;k<5&&play(p,S.chooseWord({myRack:p.rack,dictionary:DICT,bagTotal:bag.length,players:ps.length,params:prm(p.kind)}));k++);} else if(p.kind==="ours2"){for(let k=0;k<5&&play(p,S.chooseWord({myRack:p.rack,dictionary:DICT,bagTotal:bag.length,players:ps.length,params:prm(p.kind)}));k++);} else if(p.kind==="starter"||p.kind==="spender"){play(p,S.chooseWord({myRack:p.rack,dictionary:DICT}))} };
  for(const p of ps)botTurn(p);
  let idle=0;
  while(bag.length){
    const l=bag.pop()!;
    const bids=ps.map(p=>{
      if(p.kind==="ours")return S.decideBid({letter:l,myBalance:p.bal,myRack:p.rack,dictionary:DICT,bagTotal:bag.length,players:ps.length,myScore:p.score,rivals:ps.filter(q=>q!==p).map(q=>({balance:q.bal,score:q.score,known:q.known})),params:prm(p.kind)});
      if(p.kind==="spender")return Math.min(p.bal,Math.floor(p.bal/Math.max(1,bag.length+1)*3)+V[l]);
      if(p.kind==="ours2")return S.decideBid({letter:l,myBalance:p.bal,myRack:p.rack,dictionary:DICT,bagTotal:bag.length,players:ps.length,myScore:p.score,rivals:ps.filter(q=>q!==p).map(q=>({balance:q.bal,score:q.score,known:q.known})),params:prm(p.kind)});
      if(p.kind==="starter"){const v=V[l];return Math.min(p.bal,(p.rack.get(l)??0)?v:v+2)}
      const v=V[l],j=Math.floor(Math.random()*5)-2;const base=p.kind==="cheap"?v-1:p.kind==="value"?v:v+("AEIOU".includes(l)?4:2);
      return Math.max(0,Math.min(p.bal,Math.max(1,base+j)));
    });
    const order=ps.map((_,i)=>i).filter(i=>bids[i]>0).sort(()=>Math.random()-.5).sort((a,b)=>bids[b]-bids[a]);
    if(!order.length){if(++idle>300)break;bag.unshift(l);continue}idle=0;
    const w=ps[order[0]],paid=order[1]!==undefined?bids[order[1]]:1;
    if(w.bal>=paid){w.bal-=paid;w.rack.set(l,(w.rack.get(l)??0)+1);w.known.set(l,(w.known.get(l)??0)+1)}
    if(["cheap","value","aggr"].includes(w.kind))play(w,simBest(w.rack));
    for(const p of ps)botTurn(p);
  }
  if(process.env.DBG)console.log(ps.map(p=>`${p.kind}:${p.score} bal${p.bal} left${[...p.rack.values()].reduce((a,b)=>a+b,0)}`).join(" | "));
  return ps.map(p=>p.score);
}
const N=+(process.argv[2]??20), me=process.argv[3]??"ours";
let wins=0,place=0,t=Date.now();
for(let g=0;g<N;g++){const field=(process.env.FIELD??"cheap,value,aggr").split(",");const kinds=[me,...Array.from({length:5},()=>field[Math.floor(Math.random()*field.length)])];
 const s=game(kinds);const rank=s.filter(x=>x>s[0]).length+1;place+=rank;if(rank===1)wins++;if((g+1)%10===0)console.log(`${me} after ${g+1}: won ${wins}, avg place ${(place/(g+1)).toFixed(2)}`);}
console.log(`${me}: won ${wins}/${N}, avg place ${(place/N).toFixed(2)} (${((Date.now()-t)/N/1000).toFixed(1)}s/game)`);
