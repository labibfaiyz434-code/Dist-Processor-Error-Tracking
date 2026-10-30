
(()=>{
"use strict";
const root=document.getElementById("chanda-tracker");
if(!root)return;
const q=id=>document.getElementById(id);
const qa=(sel,scope=root)=>[...scope.querySelectorAll(sel)];
const safe=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const client=()=>window.dailyOverviewGetClient?.();
const currentViewer=()=>window.dailyOverviewCurrentUser||null;
const can=key=>typeof window.dailyOverviewCan==="function"&&window.dailyOverviewCan(key);
const creatorRoles=new Set(["Reviewer","Team Lead","Manager","Admin","System Owner"]);
let viewer=null,members=[],events=[],rosters=[],payments=[],expenses=[],closings=[];
let selectedEventId="",editMemberId="",paymentRosterId="",channel=null,loading=false,reloadTimer=null;

function notify(message,bad=false){
  try{
    if(typeof window.motionToast==="function"){
      window.motionToast(bad?"Chanda Tracker Error":"Chanda Tracker",String(message||""),bad?"error":"success",bad?4200:2600);
      return;
    }
  }catch(_){}
  const el=q("ctNotice");
  if(!el)return;
  el.hidden=false;el.textContent=String(message||"");el.classList.toggle("bad",bad);
  clearTimeout(el._t);el._t=setTimeout(()=>{el.hidden=true;el.classList.remove("bad")},bad?5000:3000);
}
function todayISO(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function currentMonthKey(){return todayISO().slice(0,7)}
function monthStart(key){return `${key}-01`}
function monthLabel(key){
  const [y,m]=String(key||"").split("-").map(Number);
  if(!y||!m)return key||"";
  return new Date(y,m-1,1,12).toLocaleDateString("en-US",{month:"long",year:"numeric"});
}
function fmtDate(value){
  if(!value)return"—";
  const [y,m,d]=String(value).slice(0,10).split("-").map(Number);
  if(!y||!m||!d)return String(value);
  return new Date(y,m-1,d,12).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});
}
function money(value){
  const n=Number(value)||0,abs=Math.abs(n).toLocaleString("en-BD",{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2});
  return `${n<0?"-৳":"৳"}${abs}`;
}
function pdfMoney(value){
  const n=Number(value)||0;
  return `BDT ${n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}
function stamp(value){
  if(!value)return"—";
  try{return new Date(value).toLocaleString("en-GB",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch{return String(value)}
}
function isOwner(event){return !!viewer&&event?.owner_user_id===viewer.id}
function canEditEvent(event){return isOwner(event)&&can("chanda.create")&&["Draft","Open"].includes(event.status)}
function canTransfer(){return can("chanda.transfer")&&viewer?.role==="System Owner"}
function statusClass(s){return String(s||"").toLowerCase()}
function openModal(id){const el=q(id);if(!el)return;el.classList.add("show");el.setAttribute("aria-hidden","false")}
function closeModal(id){const el=q(id);if(!el)return;el.classList.remove("show");el.setAttribute("aria-hidden","true")}
function setTab(name){
  qa(".ct-tab").forEach(b=>b.classList.toggle("active",b.dataset.ctTab===name));
  qa(".ct-panel").forEach(p=>p.classList.toggle("active",p.dataset.ctPanel===name));
}
function eventRoster(eventId){return rosters.filter(x=>x.event_id===eventId)}
function eventPayments(eventId){return payments.filter(x=>x.event_id===eventId)}
function eventExpenses(eventId){return expenses.filter(x=>x.event_id===eventId)}
function memberPayments(rosterId){return payments.filter(x=>x.event_member_id===rosterId)}
function paidForRoster(rosterId){return memberPayments(rosterId).reduce((sum,x)=>sum+(Number(x.amount)||0),0)}
function eventMetrics(event){
  const rs=eventRoster(event.id),ps=eventPayments(event.id),xs=eventExpenses(event.id);
  let expected=0,due=0,paidCount=0,dueCount=0,partialCount=0,excludedCount=0;
  rs.forEach(r=>{
    if(r.excluded){excludedCount++;return}
    const paid=paidForRoster(r.id),exp=Number(r.expected_amount)||0;
    expected+=exp;
    if(event.contribution_mode==="fixed"){
      const d=Math.max(0,exp-paid);due+=d;
      if(paid>=exp&&exp>0)paidCount++;
      else if(paid>0){partialCount++;dueCount++}
      else dueCount++;
    }else{
      if(paid>0)paidCount++;else dueCount++;
    }
  });
  const collected=ps.reduce((s,x)=>s+(Number(x.amount)||0),0);
  const expense=xs.reduce((s,x)=>s+(Number(x.amount)||0),0);
  return{expected,due,collected,expense,balance:collected-expense,paidCount,dueCount,partialCount,excludedCount,totalMembers:rs.length};
}
function currentMonthEvents(){
  const key=currentMonthKey();
  return events.filter(e=>String(e.event_date||"").slice(0,7)===key);
}
function openingBalance(){
  const cur=monthStart(currentMonthKey());
  const prev=closings.filter(x=>x.month<cur).sort((a,b)=>String(b.month).localeCompare(String(a.month)))[0];
  return Number(prev?.closing_balance)||0;
}
async function fetchAll(table,columns,orderCol="",ascending=true){
  const db=client();if(!db)throw new Error("Database client is not ready.");
  const out=[],page=1000;let from=0;
  while(true){
    let query=db.from(table).select(columns);
    if(orderCol)query=query.order(orderCol,{ascending});
    const {data,error}=await query.range(from,from+page-1);
    if(error)throw error;
    out.push(...(data||[]));
    if(!data||data.length<page)break;
    from+=page;
  }
  return out;
}
async function loadData(silent=false){
  viewer=currentViewer();
  if(!viewer||!can("chanda.view"))return;
  if(loading)return;
  const db=client();if(!db)return;
  loading=true;
  if(!silent){const el=q("ctNotice");if(el){el.hidden=false;el.classList.remove("bad");el.textContent="Loading Chanda Tracker…"}}
  try{
    const result=await Promise.all([
      fetchAll("quality_chanda_members","id,source_user_id,source_initial,name,designation,system_role,team_name,phone,joining_date,birthday,active,source,created_at,updated_at",