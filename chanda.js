
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
   </div>`;
}
function renderMembers(){
  const term=String(q("ctMemberSearch").value||"").trim().toLowerCase(),status=q("ctMemberStatusFilter").value;
  const list=members.filter(m=>{
    const hay=[m.name,m.source_initial,m.designation,m.system_role,m.team_name,m.phone].join(" ").toLowerCase();
    return(!term||hay.includes(term))&&(!status||(status==="active"?m.active:!m.active));
  });
  q("ctMemberRows").innerHTML=list.length?list.map(m=>`<tr>
    <td><div class="ct-person"><b>${safe(m.name)}</b><small>${safe(m.source_initial||"—")} • ${m.source==="system"?"DAILY OVERVIEW":"Manual member"}</small></div></td>
    <td>${safe(m.designation||m.system_role||"—")}</td><td>${safe(m.team_name||"—")}</td><td>${safe(m.phone||"—")}</td>
    <td>${fmtDate(m.joining_date)}</td><td>${fmtDate(m.birthday)}</td><td><span class="ct-status ${m.active?"open":"cancelled"}">${m.active?"Active":"Inactive"}</span></td>
    <td>${can("chanda.members.manage")?`<div class="ct-member-actions"><button class="btn" data-ct-member-edit="${safe(m.id)}" type="button">Edit</button><button class="btn" data-ct-member-toggle="${safe(m.id)}" type="button">${m.active?"Set Inactive":"Set Active"}</button></div>`:""}</td>
  </tr>`).join(""):`<tr><td colspan="8" class="ct-empty">No member matches this view.</td></tr>`;
}
function renderClosings(){
  q("ctClosingRows").innerHTML=closings.length?closings.map(x=>`<tr><td><b>${safe(monthLabel(String(x.month).slice(0,7)))}</b></td><td class="ct-money">${money(x.opening_balance)}</td><td class="ct-money">${money(x.total_collection)}</td><td class="ct-money">${money(x.total_expense)}</td><td class="ct-money"><b>${money(x.closing_balance)}</b></td><td>${Number(x.event_count)||0}</td><td>${stamp(x.closed_at)}</td></tr>`).join(""):`<tr><td colspan="7" class="ct-empty">No month closing summary yet. The first summary is created automatically when a month rolls over.</td></tr>`;
}
function populateEventTargets(){
  const select=q("ctEventTarget");if(!select)return;
  const current=select.value;
  select.innerHTML=`<option value="">No specific member</option>`+members.filter(m=>m.active).map(m=>`<option value="${safe(m.id)}">${safe(m.source_initial||"")} — ${safe(m.name)}</option>`).join("");
  if([...select.options].some(o=>o.value===current))select.value=current;
}
function openEventForm(){
  if(!can("chanda.create"))return;
  q("ctEventTitle").value="";q("ctEventType").value="Birthday";q("ctEventDate").value=todayISO();q("ctEventTarget").value="";q("ctContributionMode").value="fixed";q("ctPerHeadAmount").value="0";q("ctPerHeadAmount").disabled=false;q("ctExcludeTarget").checked=true;q("ctEventNote").value="";q("ctEventFormMsg").textContent="All active members will be added automatically when the event is created.";q("ctEventFormMsg").classList.remove("bad");openModal("ctEventModal");
}
async function createEvent(){
  const db=client(),title=q("ctEventTitle").value.trim(),eventDate=q("ctEventDate").value,type=q("ctEventType").value,mode=q("ctContributionMode").value,target=q("ctEventTarget").value||null,amount=Number(q("ctPerHeadAmount").value)||0,note=q("ctEventNote").value.trim(),btn=q("ctCreateEventBtn");
  if(!db||!viewer)return;
  if(title.length<2||!eventDate){q("ctEventFormMsg").textContent="Event name and date are required.";q("ctEventFormMsg").classList.add("bad");return}
  if(mode==="fixed"&&amount<=0){q("ctEventFormMsg").textContent="Enter a per-head amount greater than zero for a fixed event.";q("ctEventFormMsg").classList.add("bad");return}
  try{
    btn.disabled=true;btn.textContent="Creating…";
    const payload={title,event_type:type,event_date:eventDate,target_member_id:target,contribution_mode:mode,per_head_amount:mode==="fixed"?amount:0,exclude_target:q("ctExcludeTarget").checked,status:"Open",notes:note||null,created_by:viewer.id,created_by_name:viewer.name,created_by_initial:viewer.initial,owner_user_id:viewer.id,owner_name:viewer.name,owner_initial:viewer.initial};
    const {data,error}=await db.from("quality_chanda_events").insert(payload).select("id").single();
    if(error)throw error;
    selectedEventId=data.id;closeModal("ctEventModal");await loadData(true);setTab("events");notify("Event created. Active members were added to the contribution roster.");
  }catch(error){q("ctEventFormMsg").textContent=error.message||String(error);q("ctEventFormMsg").classList.add("bad")}
  finally{btn.disabled=false;btn.textContent="Create Event"}
}
function openMemberForm(id=""){
  if(!can("chanda.members.manage"))return;
  editMemberId=id;
  const m=members.find(x=>x.id===id);
  q("ctMemberModalTitle").textContent=m?"Edit Department Member":"Add Department Member";
  q("ctMemberName").value=m?.name||"";q("ctMemberInitial").value=m?.source_initial||"";q("ctMemberDesignation").value=m?.designation||"";q("ctMemberTeam").value=m?.team_name||"";q("ctMemberPhone").value=m?.phone||"";q("ctMemberJoining").value=m?.joining_date||"";q("ctMemberBirthday").value=m?.birthday||"";q("ctMemberActive").value=String(m?.active!==false);
  q("ctMemberFormMsg").textContent=m?.source==="system"?"Linked DAILY OVERVIEW member. Name and department details can be completed here without changing login access.":"";
  q("ctMemberFormMsg").classList.remove("bad");openModal("ctMemberModal");
}
async function saveMember(){
  const db=client(),btn=q("ctSaveMemberBtn"),name=q("ctMemberName").value.trim(),initial=q("ctMemberInitial").value.trim().toUpperCase();
  if(!db||!viewer)return;
  if(!name){q("ctMemberFormMsg").textContent="Member name is required.";q("ctMemberFormMsg").classList.add("bad");return}
  if(!editMemberId&&initial&&members.some(m=>String(m.source_initial||"").toUpperCase()===initial)){q("ctMemberFormMsg").textContent="This initial / ID already exists. Edit the existing member instead.";q("ctMemberFormMsg").classList.add("bad");return}
  const base={name,source_initial:initial||null,designation:q("ctMemberDesignation").value.trim()||null,team_name:q("ctMemberTeam").value.trim()||null,phone:q("ctMemberPhone").value.trim()||null,joining_date:q("ctMemberJoining").value||null,birthday:q("ctMemberBirthday").value||null,active:q("ctMemberActive").value==="true"};
  try{
    btn.disabled=true;btn.textContent="Saving…";
    let error;
    if(editMemberId)({error}=await db.from("quality_chanda_members").update(base).eq("id",editMemberId));
    else({error}=await db.from("quality_chanda_members").insert({...base,source:"manual",created_by:viewer.id}));
    if(error)throw error;
    closeModal("ctMemberModal");editMemberId="";await loadData(true);notify("Member saved.");
  }catch(error){q("ctMemberFormMsg").textContent=error.message||String(error);q("ctMemberFormMsg").classList.add("bad")}
  finally{btn.disabled=false;btn.textContent="Save Member"}
}
async function toggleMember(id){
  const m=members.find(x=>x.id===id),db=client();if(!m||!db||!can("chanda.members.manage"))return;
  try{const {error}=await db.from("quality_chanda_members").update({active:!m.active}).eq("id",id);if(error)throw error;await loadData(true);notify(`${m.name} marked ${m.active?"Inactive":"Active"}.`)}catch(error){notify(error.message||String(error),true)}
}
function openPaymentForm(rosterId){
  const roster=rosters.find(x=>x.id===rosterId),event=events.find(x=>x.id===roster?.event_id);if(!roster||!event||!canEditEvent(event))return;
  paymentRosterId=rosterId;
  const paid=paidForRoster(rosterId),st=paymentStatus(event,roster,paid),suggest=event.contribution_mode==="fixed"&&st.due>0?st.due:"";
  q("ctPaymentWho").textContent=`${roster.member_initial||""} — ${roster.member_name}${event.contribution_mode==="fixed"?` • Due ${money(st.due)}`:" • Flexible contribution"}`;
  q("ctPaymentAmount").value=suggest;q("ctPaymentDate").value=todayISO();q("ctPaymentMethod").value="Cash";q("ctPaymentNote").value="";q("ctPaymentFormMsg").textContent="";q("ctPaymentFormMsg").classList.remove("bad");openModal("ctPaymentModal");
}
async function savePayment(){
  const roster=rosters.find(x=>x.id===paymentRosterId),event=events.find(x=>x.id===roster?.event_id),db=client(),btn=q("ctSavePaymentBtn"),amount=Number(q("ctPaymentAmount").value)||0;
  if(!roster||!event||!db||!canEditEvent(event))return;
  if(amount<=0){q("ctPaymentFormMsg").textContent="Enter a payment amount greater than zero.";q("ctPaymentFormMsg").classList.add("bad");return}
  try{
    btn.disabled=true;btn.textContent="Saving…";
    const {error}=await db.from("quality_chanda_payments").insert({event_id:event.id,event_member_id:roster.id,amount,payment_date:q("ctPaymentDate").value||todayISO(),payment_method:q("ctPaymentMethod").value,note:q("ctPaymentNote").value.trim()||null,entered_by:viewer.id});
    if(error)throw error;
    closeModal("ctPaymentModal");paymentRosterId="";await loadData(true);notify("Payment recorded.");
  }catch(error){q("ctPaymentFormMsg").textContent=error.message||String(error);q("ctPaymentFormMsg").classList.add("bad")}
  finally{btn.disabled=false;btn.textContent="Save Payment"}
}
async function deletePayment(id){
  const p=payments.find(x=>x.id===id),event=events.find(x=>x.id===p?.event_id),db=client();if(!p||!event||!db||!canEditEvent(event))return;
  if(!confirm(`Delete ${money(p.amount)} payment recorded on ${fmtDate(p.payment_date)}?`))return;
  try{const {error}=await db.from("quality_chanda_payments").delete().eq("id",id);if(error)throw error;await loadData(true);notify("Payment deleted.")}catch(error){notify(error.message||String(error),true)}
}
async function addExpense(){
  const event=events.find(x=>x.id===selectedEventId),db=client();if(!event||!db||!canEditEvent(event))return;
  const title=q("ctExpenseTitle")?.value.trim(),amount=Number(q("ctExpenseAmount")?.value)||0;
  if(!title||amount<=0){notify("Expense title and amount are required.",true);return}
  try{
    const {error}=await db.from("quality_chanda_expenses").insert({event_id:event.id,title,category:null,amount,expense_date:q("ctExpenseDate").value||todayISO(),payment_method:q("ctExpenseMethod").value||null,paid_by:q("ctExpensePaidBy").value.trim()||null,note:q("ctExpenseNote").value.trim()||null,entered_by:viewer.id});
    if(error)throw error;await loadData(true);notify("Expense added.");
  }catch(error){notify(error.message||String(error),true)}
}
async function deleteExpense(id){
  const x=expenses.find(v=>v.id===id),event=events.find(v=>v.id===x?.event_id),db=client();if(!x||!event||!db||!canEditEvent(event))return;
  if(!confirm(`Delete expense "${x.title}" (${money(x.amount)})?`))return;
  try{const {error}=await db.from("quality_chanda_expenses").delete().eq("id",id);if(error)throw error;await loadData(true);notify("Expense deleted.")}catch(error){notify(error.message||String(error),true)}
}
function pdfReady(){return !!window.jspdf?.jsPDF}
function safeFilename(value){return String(value||"report").replace(/[^a-z0-9_-]+/gi,"_").replace(/^_+|_+$/g,"").slice(0,80)||"report"}
function pdfHeader(doc,title,subtitle){
  doc.setTextColor(30,41,59);doc.setFont("helvetica","bold");doc.setFontSize(15);doc.text("DAILY OVERVIEW",40,38);
  doc.setFontSize(19);doc.text(title,40,64);doc.setFont("helvetica","normal");doc.setFontSize(9);doc.setTextColor(90,100,120);doc.text(subtitle,40,80);
  doc.setDrawColor(220,225,232);doc.line(40,91,555,91);
}
function addPdfFooter(doc){
  const pages=doc.getNumberOfPages();
  for(let i=1;i<=pages;i++){doc.setPage(i);doc.setFontSize(8);doc.setTextColor(120);doc.text(`Generated from DAILY OVERVIEW • ${new Date().toLocaleString("en-GB")}`,40,814);doc.text(`Page ${i} of ${pages}`,555,814,{align:"right"})}
}
function generateEventPdf(eventId){
  const event=events.find(e=>e.id===eventId);if(!event)throw new Error("Event not found.");
  if(!pdfReady())throw new Error("PDF library did not load. Refresh the page and try again.");
  const {jsPDF}=window.jspdf,doc=new jsPDF({unit:"pt",format:"a4"});
  const m=eventMetrics(event),person=members.find(x=>x.id===event.target_member_id),rs=eventRoster(event.id).slice().sort((a,b)=>String(a.member_name).localeCompare(String(b.member_name))),xs=eventExpenses(event.id).slice().sort((a,b)=>String(a.expense_date).localeCompare(String(b.expense_date)));
  pdfHeader(doc,`Chanda Event Report — ${event.title}`,`${event.event_type} • ${fmtDate(event.event_date)} • Status: ${event.status}`);
  let y=111;doc.setFontSize(9);doc.setTextColor(45);
  const meta=[`Event person: ${person?.name||"N/A"}`,`Contribution: ${event.contribution_mode==="fixed"?`${pdfMoney(event.per_head_amount)} per head`:"Flexible"}`,`Owner: ${event.owner_initial||""} — ${event.owner_name||"—"}`,`Created by: ${event.created_by_initial||""} — ${event.created_by_name||"—"}`];
  meta.forEach(line=>{doc.text(line,40,y);y+=14});
  if(event.notes){const lines=doc.splitTextToSize(`Note: ${event.notes}`,510);doc.text(lines,40,y);y+=lines.length*12+4}
  doc.autoTable({startY:y+4,head:[["Expected","Collected","Due","Expense","Event Balance"]],body:[[event.contribution_mode==="fixed"?pdfMoney(m.expected):"Flexible",pdfMoney(m.collected),event.contribution_mode==="fixed"?pdfMoney(m.due):"—",pdfMoney(m.expense),pdfMoney(m.balance)]],theme:"grid",styles:{fontSize:9,cellPadding:6},headStyles:{fillColor:[54,87,183]}});
  const contributionBody=rs.map(r=>{const paid=paidForRoster(r.id),st=paymentStatus(event,r,paid),detail=memberPayments(r.id).map(p=>`${fmtDate(p.payment_date)} ${p.payment_method} ${pdfMoney(p.amount)}`).join(" | ");return[r.member_initial||"",r.member_name,r.excluded?"—":event.contribution_mode==="fixed"?pdfMoney(r.expected_amount):"Flexible",pdfMoney(paid),event.contribution_mode==="fixed"&&!r.excluded?pdfMoney(st.due):"—",st.label,detail||"—"]});
  doc.autoTable({startY:doc.lastAutoTable.finalY+14,head:[["ID","Member","Expected","Paid","Due","Status","Payment Details"]],body:contributionBody,theme:"striped",styles:{fontSize:7.5,cellPadding:4,overflow:"linebreak"},columnStyles:{1:{cellWidth:105},6:{cellWidth:130}},headStyles:{fillColor:[31,41,55]}});
  const expenseBody=xs.map(x=>[fmtDate(x.expense_date),x.title,pdfMoney(x.amount),x.payment_method||"—",x.paid_by||"—",x.note||"—"]);
  doc.autoTable({startY:doc.lastAutoTable.finalY+14,head:[["Date","Expense","Amount","Method","Paid By","Note"]],body:expenseBody.length?expenseBody:[["—","No expense recorded","—","—","—","—"]],theme:"grid",styles:{fontSize:8,cellPadding:4},headStyles:{fillColor:[180,61,54]}});
  if(event.contribution_mode==="fixed"){
    const dueRows=rs.map(r=>{const paid=paidForRoster(r.id),st=paymentStatus(event,r,paid);return{r,paid,st}}).filter(x=>!x.r.excluded&&x.st.due>0);
    doc.autoTable({startY:doc.lastAutoTable.finalY+14,head:[["Due Member","Paid","Due"]],body:dueRows.length?dueRows.map(x=>[`${x.r.member_initial||""} — ${x.r.member_name}`,pdfMoney(x.paid),pdfMoney(x.st.due)]):[["No outstanding due","—","—"]],theme:"grid",styles:{fontSize:8,cellPadding:4},headStyles:{fillColor:[181,122,18]}});
  }
  addPdfFooter(doc);
  doc.save(`Chanda_${String(event.event_date).slice(0,10)}_${safeFilename(event.title)}.pdf`);
}
function generateMonthPdf(){
  if(!pdfReady())throw new Error("PDF library did not load. Refresh the page and try again.");
  const key=currentMonthKey(),list=currentMonthEvents(),opening=openingBalance(),collection=list.reduce((s,e)=>s+eventMetrics(e).collected,0),expense=list.reduce((s,e)=>s+eventMetrics(e).expense,0),due=list.reduce((s,e)=>s+eventMetrics(e).due,0),balance=opening+collection-expense;
  const {jsPDF}=window.jspdf,doc=new jsPDF({unit:"pt",format:"a4"});
  pdfHeader(doc,`Monthly Chanda Report — ${monthLabel(key)}`,"Department contribution and expense summary");
  doc.autoTable({startY:108,head:[["Opening Balance","Collection","Expense","Outstanding Due","Current Balance"]],body:[[pdfMoney(opening),pdfMoney(collection),pdfMoney(expense),pdfMoney(due),pdfMoney(balance)]],theme:"grid",styles:{fontSize:9,cellPadding:6},headStyles:{fillColor:[54,87,183]}});
  const eventRows=list.map(e=>{const m=eventMetrics(e);return[fmtDate(e.event_date),e.title,e.event_type,e.status,pdfMoney(m.collected),pdfMoney(m.expense),e.contribution_mode==="fixed"?pdfMoney(m.due):"—",pdfMoney(m.balance),`${e.owner_initial||""} ${e.owner_name||""}`.trim()]});
  doc.autoTable({startY:doc.lastAutoTable.finalY+14,head:[["Date","Event","Type","Status","Collected","Expense","Due","Balance","Owner"]],body:eventRows.length?eventRows:[["—","No event this month","—","—","—","—","—","—","—"]],theme:"striped",styles:{fontSize:7.5,cellPadding:4},headStyles:{fillColor:[31,41,55]}});
  const dueRows=[];
  list.filter(e=>e.contribution_mode==="fixed").forEach(e=>eventRoster(e.id).forEach(r=>{if(r.excluded)return;const paid=paidForRoster(r.id),st=paymentStatus(e,r,paid);if(st.due>0)dueRows.push([e.title,`${r.member_initial||""} — ${r.member_name}`,pdfMoney(paid),pdfMoney(st.due),st.label])}));
  doc.autoTable({startY:doc.lastAutoTable.finalY+14,head:[["Event","Due Member","Paid","Due","Status"]],body:dueRows.length?dueRows:[["—","No outstanding due","—","—","—"]],theme:"grid",styles:{fontSize:8,cellPadding:4},headStyles:{fillColor:[181,122,18]}});
  addPdfFooter(doc);doc.save(`Chanda_Month_${key}.pdf`);
}
async function closeEvent(eventId){
  const event=events.find(e=>e.id===eventId),db=client();if(!event||!db||!canEditEvent(event))return;
  const m=eventMetrics(event);
  if(!confirm(`Download the final PDF and close "${event.title}"?${m.due>0?`\nOutstanding due: ${money(m.due)}`:""}`))return;
  try{
    generateEventPdf(event.id);
    const {error}=await db.from("quality_chanda_events").update({status:"Closed",closed_at:new Date().toISOString()}).eq("id",event.id);
    if(error)throw error;await loadData(true);notify("Final PDF generated and event closed.");
  }catch(error){notify(error.message||String(error),true)}
}
async function cancelEvent(eventId){
  const event=events.find(e=>e.id===eventId),db=client();if(!event||!db||!canEditEvent(event))return;
  if(!confirm(`Cancel "${event.title}"? The event will remain visible until month rollover.`))return;
  try{const {error}=await db.from("quality_chanda_events").update({status:"Cancelled"}).eq("id",event.id);if(error)throw error;await loadData(true);notify("Event cancelled.")}catch(error){notify(error.message||String(error),true)}
}
async function transferOwner(){
  const event=events.find(e=>e.id===selectedEventId),select=q("ctTransferOwner"),db=client();if(!event||!select||!db||!canTransfer())return;
  const member=members.find(m=>m.id===select.value&&m.source_user_id);
  if(!member)return;
  if(member.source_user_id===event.owner_user_id){notify("This person already owns the event.",true);return}
  if(!confirm(`Transfer "${event.title}" to ${member.name} (${member.system_role})?`))return;
  try{
    const {error}=await db.from("quality_chanda_events").update({owner_user_id:member.source_user_id,owner_name:member.name,owner_initial:member.source_initial||""}).eq("id",event.id);
    if(error)throw error;await loadData(true);notify("Event ownership transferred.");
  }catch(error){notify(error.message||String(error),true)}
}
function subscribeRealtime(){
  const db=client();if(!db||channel)return;
  const schedule=()=>{clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>loadData(true),350)};
  channel=db.channel("daily-overview-chanda-live")
   .on("postgres_changes",{event:"*",schema:"public",table:"quality_chanda_members"},schedule)
   .on("postgres_changes",{event:"*",schema:"public",table:"quality_chanda_events"},schedule)
   .on("postgres_changes",{event:"*",schema:"public",table:"quality_chanda_event_members"},schedule)
   .on("postgres_changes",{event:"*",schema:"public",table:"quality_chanda_payments"},schedule)
   .on("postgres_changes",{event:"*",schema:"public",table:"quality_chanda_expenses"},schedule)
   .on("postgres_changes",{event:"*",schema:"public",table:"quality_chanda_month_closings"},schedule)
   .subscribe();
}
function clearState(){
  try{if(channel)client()?.removeChannel(channel)}catch(_){}
  channel=null;members=[];events=[];rosters=[];payments=[];expenses=[];closings=[];selectedEventId="";viewer=null;
}
q("ctRefreshBtn")?.addEventListener("click",()=>loadData(false));
q("ctNewEventBtn")?.addEventListener("click",openEventForm);
q("ctNewMemberBtn")?.addEventListener("click",()=>openMemberForm(""));
q("ctMonthPdfBtn")?.addEventListener("click",()=>{try{generateMonthPdf()}catch(e){notify(e.message||String(e),true)}});
q("ctViewAllEventsBtn")?.addEventListener("click",()=>setTab("events"));
q("ctContributionMode")?.addEventListener("change",()=>{const flexible=q("ctContributionMode").value==="flexible";q("ctPerHeadAmount").disabled=flexible;if(flexible)q("ctPerHeadAmount").value="0"});
q("ctCreateEventBtn")?.addEventListener("click",createEvent);
q("ctSaveMemberBtn")?.addEventListener("click",saveMember);
q("ctSavePaymentBtn")?.addEventListener("click",savePayment);
q("ctEventStatusFilter")?.addEventListener("change",renderEvents);
q("ctEventOwnerFilter")?.addEventListener("change",renderEvents);
q("ctMemberSearch")?.addEventListener("input",renderMembers);
q("ctMemberStatusFilter")?.addEventListener("change",renderMembers);
qa("[data-ct-tab]").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.ctTab)));
qa("[data-ct-close]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.ctClose)));
qa(".ct-modal").forEach(m=>m.addEventListener("click",e=>{if(e.target===m)closeModal(m.id)}));
root.addEventListener("click",e=>{
  const eventCard=e.target.closest("[data-ct-event]");
  if(eventCard){selectedEventId=eventCard.dataset.ctEvent;setTab("events");renderEvents();return}
  const edit=e.target.closest("[data-ct-member-edit]");if(edit){openMemberForm(edit.dataset.ctMemberEdit);return}
  const toggle=e.target.closest("[data-ct-member-toggle]");if(toggle){toggleMember(toggle.dataset.ctMemberToggle);return}
  const pay=e.target.closest("[data-ct-pay]");if(pay){openPaymentForm(pay.dataset.ctPay);return}
  const delPay=e.target.closest("[data-ct-delete-payment]");if(delPay){deletePayment(delPay.dataset.ctDeletePayment);return}
  const delExpense=e.target.closest("[data-ct-delete-expense]");if(delExpense){deleteExpense(delExpense.dataset.ctDeleteExpense);return}
  const report=e.target.closest("[data-ct-report]");if(report){try{generateEventPdf(report.dataset.ctReport)}catch(err){notify(err.message||String(err),true)}return}
  const close=e.target.closest("[data-ct-close-event]");if(close){closeEvent(close.dataset.ctCloseEvent);return}
  const cancel=e.target.closest("[data-ct-cancel-event]");if(cancel){cancelEvent(cancel.dataset.ctCancelEvent);return}
  if(e.target.closest("#ctAddExpenseBtn")){addExpense();return}
  if(e.target.closest("#ctTransferBtn")){transferOwner();return}
});
document.querySelector('.navbtn[data-page="chanda-tracker"]')?.addEventListener("click",()=>{setTimeout(()=>loadData(true),0)});
window.addEventListener("daily-overview-session-ready",ev=>{viewer=ev.detail||currentViewer();loadData(false)});
window.addEventListener("daily-overview-session-ended",()=>clearState());
if(currentViewer())setTimeout(()=>loadData(true),0);
})();
