import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
if(!['127.0.0.1','localhost','terminal.local'].includes(new URL(base).hostname))throw new Error('Tests must run only against local preview.');
const run=randomBytes(4).toString('hex'), pass=randomBytes(18).toString('hex');
let count=0;function ok(value,label){assert.ok(value,label);count++;console.log('PASS '+label);}
function client(){let cookie='';return async(path,method='GET',data)=>{const r=await fetch(base+'/api/'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];const d=await r.json();return{status:r.status,data:d};};}
const a=client(),b=client(),c=client(),anon=client();
const users=[];for(const [i,cl]of[a,b,c].entries()){const r=await cl('auth/register','POST',{username:'qa_'+run+i,password:pass,nickname:'검증'+run+i,role:'manager'});ok(r.status===200&&r.data.user.role==='member','register ignores role '+i);users.push(r.data.user);}
ok((await a('auth/me')).data.user.id===users[0].id,'session persists');
const duplicate=await anon('auth/register','POST',{username:'qa_'+run+0,password:pass,nickname:'중복'+run});ok(duplicate.status===409,'duplicate username rejected');
ok((await anon('auth/register','POST',{username:'sosirusok',password:pass,nickname:'예약'+run})).status===409,'manager username reserved');
ok((await anon('auth/login','POST',{username:'qa_'+run+0,password:'wrong_password'})).status===401,'bad password rejected');
const p={kind:'sell',title:'검증용 마스터 계정 '+run,body:'로컬 검증용 게시글입니다.',price:50000,tags:[{tier:'master',season:29},{tier:'master',season:30},{tier:'iron',season:25}]};
ok((await anon('posts','POST',p)).status===401,'anonymous creation rejected');
ok((await a('posts','POST',{...p,tags:[{tier:'iron',season:17}]})).status===400,'invalid season rejected');
const created=await a('posts','POST',p);ok(created.status===201,'post created');const pid=created.data.id;
ok((await anon('posts/'+pid)).data.post.tags.length===3,'season selections saved');
ok((await b('posts/'+pid,'PUT',p)).status===403,'other member edit blocked');
ok((await b('posts/'+pid,'DELETE')).status===403,'other member delete blocked');
const filter=async(tags)=>anon('posts?tags='+encodeURIComponent(JSON.stringify(tags)));
ok((await filter([{tier:'master',season:29},{tier:'champion',season:32}])).data.posts.some(p=>p.id===pid),'OR match accepted');
ok(!(await filter([{tier:'master',season:25},{tier:'iron',season:29}])).data.posts.some(p=>p.id===pid),'tier and season cross-match prevented');
const mins={iron:25,bronze:6,silver:6,gold:6,platinum:6,diamond:6,master:17,challenger:6,champion:8};const all=Object.entries(mins).flatMap(([tier,min])=>Array.from({length:33-min},(_,i)=>({tier,season:i+min})));
ok((await filter(all)).data.posts.some(p=>p.id===pid),'all 211 season selections supported');
const edited=await a('posts/'+pid,'PUT',{...p,title:'검증용 수정된 제목',tags:[{tier:'champion',season:8}],status:'closed'});ok(edited.status===200,'owner edits');const stored=(await a('posts/'+pid)).data.post;ok(stored.tags.length===1&&stored.tags[0].season===8&&stored.status==='closed','edit replaces tags and status');
const [ca,cb]=await Promise.all([a('chats','POST',{userId:users[1].id}),b('chats','POST',{userId:users[0].id})]);ok(ca.data.id===cb.data.id,'one room per member pair');const room=ca.data.id;
ok((await c('chats/'+room+'/messages')).status===404,'third party chat read blocked');
ok((await c('chats/'+room+'/messages','POST',{body:'unauthorized'})).status===404,'third party chat write blocked');
const sent=await a('chats/'+room+'/messages','POST',{body:'테스트 메시지입니다.',sender_id:users[2].id});ok(sent.status===201,'member sends message');const received=(await b('chats/'+room+'/messages')).data.messages;ok(received.length===1&&received[0].sender_id===users[0].id,'peer receives and sender spoof blocked');
ok((await b('chats')).data.chats.find(r=>r.id===room).unread===1,'unread count');await b('chats/'+room+'/read','POST',{lastId:received[0].id});ok((await b('chats')).data.chats.find(r=>r.id===room).unread===0,'read state persists');
ok((await c('users/'+users[0].id,'PUT',{nickname:'악의적변경',bio:''})).status===403,'other profile edit blocked');
const publicUser=(await anon('users/'+users[0].id)).data.user;ok(!('password_hash'in publicUser)&&!('username'in publicUser)&&!('salt'in publicUser),'public profile excludes credentials');
await a('users/'+users[0].id,'PUT',{nickname:'변경'+run,bio:'프로필 소개'});ok((await b('chats')).data.chats.find(r=>r.id===room).nickname==='변경'+run,'nickname update reflected in chat');
await a('auth/logout','POST',{});ok((await a('auth/me')).data.user===null,'logout invalidates session');
ok((await a('auth/login','POST',{username:'qa_'+run+0,password:pass})).status===200,'login after logout');
ok((await a('posts/'+pid,'DELETE')).status===200&&(await anon('posts/'+pid)).status===404,'owner deletes post');
console.log(JSON.stringify({passed:count,localTestUsers:users.map(u=>u.id)}));
