'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, MessageCircle, PenLine, Heart, History, UserRound, LogOut, ArrowUpRight, Bookmark, Settings, ChevronRight, Gamepad2, Package, Ticket, Users, Swords, ArrowLeftRight, Megaphone, Menu } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { CATEGORIES, KIND_NAMES, categoriesForKind, type User } from '@/lib/market';
import { api, Avatar, Role, AuthDialog, MarketApp, errorMessage } from '@/components/market/shared';
import { Board } from '@/components/market/board';
import { Editor } from '@/components/market/editor';
import { Detail } from '@/components/market/detail';
import { Chat, Profile, Activity, Manage, Guide } from '@/components/market/community';
export default function Market() {
    const router = useRouter(), path = usePathname() || '/', params = useSearchParams(), [me, setMe] = useState<User | null>(null), [ready, setReady] = useState(false), [auth, setAuth] = useState(''), [stats, setStats] = useState<any>({ members: 0, posts: 0, categories: [] }), [revision, setRevision] = useState(0), [unread, setUnread] = useState(0), [query, setQuery] = useState(''), [mobile, setMobile] = useState(false), [error, setError] = useState('');
    const parts = path.split('/').filter(Boolean), page = parts[0] || 'board', category = params.get('category') || '';
    const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
    const setBeforeLeave = useCallback((guard: (() => Promise<boolean>) | null) => { leaveGuard.current = guard; }, []);
    const go = useCallback(async (p: string) => { if (leaveGuard.current && !await leaveGuard.current())
        return; setMobile(false); router.push(p); }, [router]);
    const refresh = useCallback(() => { setRevision(n => n + 1); api('stats').then(setStats).catch(() => { }); }, []);
    useEffect(() => { Promise.all([api('auth/me'), api('stats')]).then(([u, s]) => { setMe(u.user); setStats(s); }).catch(e => setError(errorMessage(e))).finally(() => setReady(true)); }, []);
    useEffect(() => { if (!me) {
        setUnread(0);
        return;
    } let active = true; const update = () => { if (document.hidden)
        return; api('chats').then(d => { if (active)
        setUnread(d.chats.reduce((n: number, c: any) => n + c.unread, 0)); }).catch(() => { }); }; update(); const t = setInterval(update, 6000); return () => { active = false; clearInterval(t); }; }, [me?.id, revision]);
    const pendingAction = useRef<{path?:string; run?:()=>void; chat?:{userId:string;postId?:number}} | null>(null);
    const login = (next?: string | (()=>void)) => { pendingAction.current = typeof next === 'string' ? {path:next} : typeof next === 'function' ? {run:next} : null; setAuth('login'); };
    const guard = (p: string) => me ? go(p) : login(p);
    const startChat = async (userId: string, postId?: number) => { try { const d = await api('chats', 'POST', {userId,postId}); go('/chat/' + d.id); } catch(e) { toast.error(errorMessage(e)); } };
    const chat = async (userId: string, postId?: number) => { if (!me) { pendingAction.current={chat:{userId,postId}}; setAuth('login'); return; } await startChat(userId,postId); };
    const authSuccess = (user: User) => { const next=pendingAction.current; pendingAction.current=null; setMe(user); setError(''); refresh(); if(next?.path) go(next.path); else if(next?.chat) void startChat(next.chat.userId,next.chat.postId); else next?.run?.(); };
    const authMode = (value:string) => { if (!value) pendingAction.current=null; setAuth(value); };
    const activeKind = Object.hasOwn(KIND_NAMES, params.get('kind') || '') ? params.get('kind')! : 'sell';
    const writeCategory = categoriesForKind(activeKind).some(c => c.id === category) ? category : categoriesForKind(activeKind)[0].id;
    const writeUrl = '/write?' + new URLSearchParams({kind:activeKind, category:writeCategory, ...(activeKind === 'exchange' && params.get('wantedCategory') ? {wantedCategory:params.get('wantedCategory')!} : {})}).toString();
    const logout = async () => { if (leaveGuard.current && !await leaveGuard.current())
        return; try {
        await api('auth/logout', 'POST', {});
        setMe(null);
        go('/');
        toast.success('로그아웃되었습니다.');
    }
    catch (e) {
        toast.error(errorMessage(e));
    } };
    const context = { me, ready, go, login, refresh, setMe, chat, revision, setBeforeLeave };
    return <MarketApp.Provider value={context}><Toaster theme="light" position="top-center"/>
    <header className="market-header"><div className="header-inner"><a className="wordmark" href="/" onClick={e => { e.preventDefault(); go('/'); }}><strong>좀비고 거래소</strong></a><nav className="main-nav" aria-label="주 메뉴"><button className={page === 'board' ? 'current' : ''} aria-current={page === 'board' ? 'page' : undefined} onClick={() => go('/')}>거래 찾기</button><button className={page === 'activity' ? 'current' : ''} aria-current={page === 'activity' ? 'page' : undefined} onClick={() => guard('/activity/posts')}>내 거래</button></nav><div className="header-actions"><button className="header-chat" aria-label="채팅" onClick={() => guard('/chat')}><MessageCircle size={20}/><span className="header-action-label">채팅</span>{unread > 0 && <b className="unread-badge">{unread > 99 ? '99+' : unread}</b>}</button><DropdownMenu><DropdownMenuTrigger asChild><button className="account-menu-trigger" aria-label="내 메뉴">{me ? <Avatar name={me.nickname}/> : <UserRound size={20}/>}<span className="header-action-label">내 정보</span></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="account-menu"><DropdownMenuLabel>{me ? me.nickname : '내 거래 관리'}</DropdownMenuLabel>{me ? <DropdownMenuItem onSelect={() => go('/profile/' + me.id)}>내 프로필</DropdownMenuItem> : <><DropdownMenuItem onSelect={() => login()}>로그인</DropdownMenuItem><DropdownMenuItem onSelect={() => setAuth('register')}>회원가입</DropdownMenuItem></>}<DropdownMenuSeparator/><DropdownMenuItem onSelect={() => guard(writeUrl)}>거래 등록</DropdownMenuItem>{[['posts', '내가 쓴 글'], ['favorites', '찜한 글'], ['offers', '받은 / 보낸 제안'], ['recent', '최근 본 글'], ['searches', '저장한 검색'], ['uploads', '사진 관리'], ['blocks', '차단 관리']].map(([key, label]) => <DropdownMenuItem key={key} onSelect={() => guard('/activity/' + key)}>{label}</DropdownMenuItem>)}<DropdownMenuSeparator/><DropdownMenuItem onSelect={() => go('/')}>거래 목록</DropdownMenuItem><DropdownMenuItem onSelect={() => go('/guide')}>공지와 이용 안내</DropdownMenuItem>{me?.role === 'manager' && <DropdownMenuItem onSelect={() => go('/manage')}>매니저 관리</DropdownMenuItem>}{me && <><DropdownMenuSeparator/><DropdownMenuItem onSelect={logout}>로그아웃</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>{!me && <button className="login-top" onClick={() => login()}>로그인</button>}<button className="primary header-compose" onClick={() => guard(writeUrl)}>거래 등록</button></div></div></header>
    <div className="market-wrap"><div className="market-layout"> <main className={'market-main page-' + page}>{error && <div className="error-banner">{error}<button onClick={() => location.reload()}>새로고침</button></div>}{page === 'board' ? <Board /> : page === 'write' || page === 'edit' ? <Editor key={path + (me?.id || '')} id={page === 'edit' ? parts[1] : undefined}/> : page === 'posts' ? <Detail key={parts[1]} id={parts[1]}/> : page === 'chat' ? <Chat key={(me?.id || '') + path} id={parts[1]}/> : page === 'profile' ? <Profile key={parts[1]} id={parts[1]}/> : page === 'activity' ? <Activity key={parts[1]} tab={parts[1] || 'posts'}/> : page === 'manage' ? <Manage /> : <Guide />}</main></div><footer className="market-footer"><strong>좀비고 거래소</strong><p>회원 간 직접 거래 커뮤니티이며 게임 운영사와 관계가 없습니다.</p><button onClick={() => go('/guide')}>이용 안내</button><a href="https://awesomepiece.com/management.html" target="_blank" rel="noreferrer">게임 운영정책</a></footer></div><AuthDialog mode={auth} setMode={authMode} onSuccess={authSuccess}/></MarketApp.Provider>;
}
