
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
      fetchAll("quality_chanda_members","id,source_user_id,source_initial,name,designation,system_role,team_name,phone,joining_date,birthday,active,source,created_at,updated_at","name",true),
      fetchAll("quality_chanda_events","id,title,event_type,event_date,target_member_id,contribution_mode,per_head_amount,exclude_target,status,notes,created_by,created_by_name,created_by_initial,owner_user_id,owner_name,owner_initial,created_at,updated_at,closed_at","event_date",false),
      fetchAll("quality_chanda_event_members","id,event_id,member_id,member_name,member_initial,member_designation,expected_amount,excluded,exclusion_reason,created_at,updated_at","created_at",true),
      fetchAll("quality_chanda_payments","id,event_id,event_member_id,amount,payment_date,payment_method,note,entered_by,created_at,updated_at","created_at",true),
      fetchAll("quality_chanda_expenses","id,event_id,title,category,amount,expense_date,payment_method,paid_by,note,entered_by,created_at,updated_at","expense_date",true),
      fetchAll("quality_chanda_month_closings","month,opening_balance,total_collection,total_expense,closing_balance,event_count,closed_at,closed_by","month",false)
    ]);
    [members,events,rosters,payments,expenses,closings]=result;
    if(selectedEventId&&!events.some(e=>e.id===selectedEventId))selectedEventId="";
    renderAll();
    subscribeRealtime();
    const el=q("ctNotice");if(el&&!silent)el.hidden=true;
  }catch(error){
    console.error("Chanda Tracker load failed",error);
    notify(error.message||String(error),true);
  }finally{loading=false}
}
function renderAll(){
  viewer=currentViewer()||viewer;
  q("ctNewEventBtn").style.display=can("chanda.create")?"":"none";
  q("ctNewMemberBtn").style.display=can("chanda.members.manage")?"":"none";
  renderStats();renderDashboard();renderEvents();renderMembers();renderClosings();populateEventTargets();
}
function renderStats(){
  const list=currentMonthEvents();
  const opening=openingBalance();
  const totals=list.reduce((acc,e)=>{const m=eventMetrics(e);acc.collection+=m.collected;acc.expense+=m.expense;acc.due+=m.due;if(["Draft","Open"].includes(e.status))acc.active++;return acc},{collection:0,expense:0,due:0,active:0});
  q("ctStatOpening").textContent=money(opening);
  q("ctStatCollection").textContent=money(totals.collection);
  q("ctStatExpense").textContent=money(totals.expense);
  q("ctStatBalance").textContent=money(opening+totals.collection-totals.expense);
  q("ctStatDue").textContent=money(totals.due);
  q("ctStatEvents").textContent=String(totals.active);
}
function eventCardHtml(event){
  const m=eventMetrics(event),person=members.find(x=>x.id===event.target_member_id);
  return `<article class="ct-event-card ${selectedEventId===event.id?"selected":""}" data-ct-event="${safe(event.id)}">
    <div class="ct-event-main"><span class="ct-status ${statusClass(event.status)}">${safe(event.status)}</span><b>${safe(event.title)}</b><span>${safe(event.event_type)} • ${fmtDate(event.event_date)}${person?` • For ${safe(person.name)}`:""}</span></div>
    <div class="ct-event-metric"><b>${money(m.collected)}</b><span>Collected</span></div>
    <div class="ct-event-metric"><b>${money(m.due)}</b><span>Due</span></div>
    <div class="ct-event-metric"><b>${money(m.expense)}</b><span>Expense</span></div>
    <div class="ct-event-metric"><b>${money(m.balance)}</b><span>Event Balance</span></div>
    <div class="ct-event-arrow">›</div>
  </article>`;
}
function renderDashboard(){
  const key=currentMonthKey(),list=currentMonthEvents().sort((a,b)=>String(a.event_date).localeCompare(String(b.event_date)));
  q("ctDashboardEvents").innerHTML=list.length?list.map(eventCardHtml).join(""):`<div class="ct-empty">No event created for ${safe(monthLabel(key))} yet.</div>`;
  q("ctBirthdayMonth").textContent=monthLabel(key);
  const month=key.slice(5,7),today=todayISO();
  const bdays=members.filter(m=>m.active&&m.birthday&&String(m.birthday).slice(5,7)===month).sort((a,b)=>String(a.birthday).slice(5).localeCompare(String(b.birthday).slice(5)));
  q("ctBirthdays").innerHTML=bdays.length?bdays.map(m=>{
    const md=String(m.birthday).slice(5),date=`${key.slice(0,4)}-${md}`,tag=date===today?"Today":date>today?"Upcoming":"Passed";
    return `<div class="ct-birthday"><div><b>${safe(m.name)}${m.source_initial?` • ${safe(m.source_initial)}`:""}</b><span>${safe(m.designation||m.system_role||"Department Member")} • ${safe(tag)}</span></div><span class="ct-birthday-date">${fmtDate(date)}</span></div>`;
  }).join(""):`<div class="ct-empty">No birthday is recorded for ${safe(monthLabel(key))}. Add birthday dates from Members.</div>`;
}
function filteredEvents(){
  const status=q("ctEventStatusFilter").value,owner=q("ctEventOwnerFilter").value;
  return events.filter(e=>(!status||e.status===status)&&(!owner||owner!=="mine"||e.owner_user_id===viewer?.id));
}
function renderEvents(){
  const list=filteredEvents();
  q("ctEventList").innerHTML=list.length?list.map(eventCardHtml).join(""):`<div class="ct-empty">No event matches this view.</div>`;
  renderEventDetail();
}
function paymentStatus(event,roster,paid){
  if(roster.excluded)return{key:"excluded",label:"Excluded",due:0};
  if(event.contribution_mode==="flexible")return paid>0?{key:"paid",label:"Contributed",due:0}:{key:"due",label:"No Contribution",due:0};
  const expected=Number(roster.expected_amount)||0,due=Math.max(0,expected-paid);
  if(expected>0&&paid>=expected)return{key:"paid",label:"Paid",due:0};
  if(paid>0)return{key:"partial",label:"Partial",due};
  return{key:"due",label:"Due",due};
}
function renderPaymentDetails(event,roster,editable){
  const list=memberPayments(roster.id);
  if(!list.length)return`<small style="color:var(--muted)">—</small>`;
  return list.map(p=>`<div style="display:flex;align-items:center;gap:4px;margin:2px 0;white-space:nowrap"><small>${fmtDate(p.payment_date)} • ${safe(p.payment_method)} • ${money(p.amount)}</small>${editable?`<button class="btn" style="padding:2px 4px;font-size:8px!important" data-ct-delete-payment="${safe(p.id)}" title="Delete this payment">×</button>`:""}</div>`).join("");
}
function eligibleOwners(){
  return members.filter(m=>m.active&&m.source_user_id&&creatorRoles.has(m.system_role)).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
}
function renderEventDetail(){
  const host=q("ctEventDetail"),event=events.find(e=>e.id===selectedEventId);
  if(!event){host.innerHTML=`<div class="ct-event-detail-empty">Select an event to view contribution, due, expense and report controls.</div>`;return}
  const metrics=eventMetrics(event),editable=canEditEvent(event),person=members.find(x=>x.id===event.target_member_id),rs=eventRoster(event.id).slice().sort((a,b)=>String(a.member_name).localeCompare(String(b.member_name))),xs=eventExpenses(event.id).slice().sort((a,b)=>String(b.expense_date).localeCompare(String(a.expense_date)));
  const transfer=canTransfer()?`<div class="ct-transfer-box"><select class="select" id="ctTransferOwner">${eligibleOwners().map(m=>`<option value="${safe(m.id)}" ${m.source_user_id===event.owner_user_id?"selected":""}>${safe(m.source_initial||"")} — ${safe(m.name)} (${safe(m.system_role||"")})</option>`).join("")}</select><button class="btn" id="ctTransferBtn" type="button">${event.owner_user_id===viewer?.id?"Transfer Ownership":"Take Over / Transfer"}</button></div>`:"";
  const contributionRows=rs.map(r=>{
    const paid=paidForRoster(r.id),st=paymentStatus(event,r,paid),expected=Number(r.expected_amount)||0;
    return `<tr>
      <td><div class="ct-person"><b>${safe(r.member_name)}</b><small>${safe(r.member_initial||"")} ${r.member_designation?`• ${safe(r.member_designation)}`:""}</small></div></td>
      <td class="ct-money">${r.excluded?"—":event.contribution_mode==="fixed"?money(expected):"Flexible"}</td>
      <td class="ct-money">${money(paid)}</td>
      <td class="ct-money">${event.contribution_mode==="fixed"&&!r.excluded?money(st.due):"—"}</td>
      <td><span class="ct-pay-status ${st.key}">${safe(st.label)}</span>${r.exclusion_reason?`<small style="display:block;margin-top:3px;color:var(--muted)">${safe(r.exclusion_reason)}</small>`:""}</td>
      <td>${renderPaymentDetails(event,r,editable)}</td>
      <td>${editable&&!r.excluded?`<button class="btn" data-ct-pay="${safe(r.id)}" type="button">＋ Payment</button>`:""}</td>
    </tr>`;
  }).join("");
  const expenseForm=editable?`<div class="ct-expense-form">
      <input id="ctExpenseTitle" class="wide" placeholder="Expense title (Gift, Cake, Food…)">
      <input id="ctExpenseAmount" type="number" min="1" step="1" placeholder="Amount">
      <input id="ctExpenseDate" type="date" value="${todayISO()}">
      <select id="ctExpenseMethod"><option>Cash</option><option>bKash</option><option>Nagad</option><option>Bank</option><option>Other</option></select>
      <input id="ctExpensePaidBy" placeholder="Paid by (optional)">
      <textarea id="ctExpenseNote" class="wide" placeholder="Optional note"></textarea>
      <button class="btn primary wide" id="ctAddExpenseBtn" type="button">Add Expense</button>
    </div>`:"";
  const expenseList=xs.length?xs.map(x=>`<div class="ct-expense-item"><div><b>${safe(x.title)}</b><small>${fmtDate(x.expense_date)} • ${safe(x.payment_method||"—")}${x.paid_by?` • Paid by ${safe(x.paid_by)}`:""}${x.note?` • ${safe(x.note)}`:""}</small></div><strong>${money(x.amount)}</strong>${editable?`<button class="btn danger" data-ct-delete-expense="${safe(x.id)}" type="button">Delete</button>`:""}</div>`).join(""):`<div class="ct-empty">No expense recorded.</div>`;
  const actionButtons=[
    `<button class="btn" data-ct-report="${safe(event.id)}" type="button">PDF Report</button>`,
    editable?`<button class="btn primary" data-ct-close-event="${safe(event.id)}" type="button">Close + PDF</button>`:"",
    editable?`<button class="btn danger" data-ct-cancel-event="${safe(event.id)}" type="button">Cancel Event</button>`:""
  ].join("");
  host.innerHTML=`<div class="ct-detail-hero">
    <div><span class="ct-status ${statusClass(event.status)}">${safe(event.status)}</span><h3>${safe(event.title)}</h3><div class="ct-detail-meta">${safe(event.event_type)} • ${fmtDate(event.event_date)}${person?` • For ${safe(person.name)}`:""}<br>Contribution: ${event.contribution_mode==="fixed"?`${money(event.per_head_amount)} per head`:"Flexible"} • Owner: ${safe(event.owner_initial||"")} — ${safe(event.owner_name||"—")}${event.notes?`<br>${safe(event.notes)}`:""}</div>${transfer}</div>
    <div class="ct-detail-actions">${actionButtons}</div>
   </div>
   <div class="ct-event-summary">
    <div class="ct-mini-stat"><span>Expected</span><b>${event.contribution_mode==="fixed"?money(metrics.expected):"Flexible"}</b></div>
    <div class="ct-mini-stat"><span>Collected</span><b>${money(metrics.collected)}</b></div>
    <div class="ct-mini-stat"><span>Due</span><b>${event.contribution_mode==="fixed"?money(metrics.due):"—"}</b></div>
    <div class="ct-mini-stat"><span>Expense</span><b>${money(metrics.expense)}</b></div>
    <div class="ct-mini-stat"><span>Event Balance</span><b>${money(metrics.balance)}</b></div>
   </div>
   <div class="ct-owner-note">${editable?`You are the event owner. Only your signed-in account can add or remove this event's collection and expense entries.`:`Managed by ${safe(event.owner_name||event.owner_initial||"event owner")}. Financial entry controls are read-only for other users.`}${event.status==="Closed"?` Download and keep the PDF report before the next month rollover.`:""}</div>
   <div class="ct-detail-grid" style="margin-top:10px">
    <div class="ct-subcard"><h4>Contribution Register</h4><div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Member</th><th>Expected</th><th>Paid</th><th>Due</th><th>Status</th><th>Payment History</th><th></th></tr></thead><tbody>${contributionRows||`<tr><td colspan="7" class="ct-empty">No roster.</td></tr>`}</tbody></table></div></div>
    <div class="ct-subcard"><h4>Expenses</h4>${expenseForm}<div class="ct-expense-list">${expenseList}</div><div class="ct-report-hint">Event report includes full contribution, due and expense details.</div></div>
