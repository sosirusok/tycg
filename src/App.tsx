import { lazy, Suspense, useEffect } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Toaster, toast } from 'sonner';
import { BadgeCheck, House, LayoutList, MessageCircle, PenLine, UserRound } from 'lucide-react';
import { Link, navigate, useLocation } from './lib/router';
import { api, errorText } from './lib/api';
import { AppProvider, useApp } from './app/state';
import { Avatar, CIcon, NameLine, SkeletonRows } from './components/ui';
import { AuthModal } from './app/AuthModal';
import { ApplyModal } from './app/ApplyModal';
import { Home } from './pages/Home';
import { Board } from './pages/Board';
import { Detail } from './pages/Detail';

const Editor = lazy(() => import('./pages/Editor'));
const Chat = lazy(() => import('./pages/Chat'));
const Profile = lazy(() => import('./pages/Profile'));
const Mine = lazy(() => import('./pages/Mine'));
const Manage = lazy(() => import('./pages/Manage'));
const Guide = lazy(() => import('./pages/Guide'));

export default function App() {
    return <AppProvider><Shell /></AppProvider>;
}

function writeHref(params: URLSearchParams, path: string) {
    if (path !== '/trade') return '/write';
    const q = new URLSearchParams();
    for (const key of ['kind', 'category', 'wantedCategory']) { const v = params.get(key); if (v) q.set(key, v); }
    return '/write' + (q.toString() ? '?' + q : '');
}

function Shell() {
    const { me, unread, requireLogin, openAuth, openApply, setMe } = useApp();
    const { path, params, parts } = useLocation();
    const page = parts[0] || '';
    const write = writeHref(params, path);

    // Links from the previous version (board at "/?kind=…", "/activity/…").
    useEffect(() => {
        if (path === '/' && params.get('kind')) void navigate('/trade?' + params.toString(), { replace: true, force: true });
        if (page === 'activity') void navigate('/me/' + (parts[1] || 'posts'), { replace: true, force: true });
    }, [path, params, page, parts]);

    async function logout() {
        try { await api('auth/logout', 'POST', {}); setMe(null); void navigate('/'); toast('로그아웃했습니다.'); }
        catch (e) { toast.error(errorText(e)); }
    }
    const go = (to: string) => requireLogin(() => void navigate(to));

    return <>
        <Toaster position="top-center" toastOptions={{ className: 'toast' }} />
        <header className="header">
            <div className="container header-inner">
                <Link to="/" className="logo" aria-label="좀비고 거래소 홈"><CIcon name="man-zombie" size={28} />좀비고 거래소</Link>
                <nav className="nav" aria-label="주 메뉴">
                    {([['/trade?kind=sell', '판매', 'sell'], ['/trade?kind=buy', '구매', 'buy'], ['/trade?kind=exchange', '교환', 'exchange'], ['/trade?kind=proxy_offer', '대리', 'proxy']] as const).map(([to, label, key]) => {
                        const kind = params.get('kind') || '';
                        const current = page === 'trade' && (key === 'proxy' ? kind.startsWith('proxy') : kind === key);
                        return <Link key={key} to={to} aria-current={current ? 'page' : undefined}>{label}</Link>;
                    })}
                    <Link to="/guide" aria-current={page === 'guide' ? 'page' : undefined}>공지</Link>
                </nav>
                <div className="header-right">
                    <button type="button" className="header-link header-apply" aria-label="인증/등급 신청하기" onClick={() => openApply()}>
                        <BadgeCheck size={18} /><span className="label-long">인증/등급 신청하기</span><span className="label-short">인증·등급 신청</span>
                    </button>
                    <button type="button" className="header-link header-chat" aria-label={`채팅${unread ? `, 읽지 않은 메시지 ${unread}개` : ''}`} onClick={() => go('/chat')}>
                        <MessageCircle size={20} /><span className="header-link-text">채팅</span>
                        {unread > 0 && <b className="badge-count">{unread > 99 ? '99+' : unread}</b>}
                    </button>
                    {me ? <DropdownMenu.Root>
                        <DropdownMenu.Trigger className="account-trigger" aria-label="내 메뉴"><Avatar name={me.nickname} size="sm" /><span>{me.nickname}</span></DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content className="menu" align="end" sideOffset={8}>
                                <div className="menu-label"><NameLine nickname={me.nickname} grade={me.grade} role={me.role} badges={me.badges} /></div>
                                <DropdownMenu.Item className="menu-item" onSelect={() => void navigate('/profile/' + me.id)}>내 프로필</DropdownMenu.Item>
                                <DropdownMenu.Item className="menu-item" onSelect={() => void navigate('/me/posts')}>내 거래</DropdownMenu.Item>
                                <DropdownMenu.Item className="menu-item" onSelect={() => void navigate('/me/favorites')}>찜한 글</DropdownMenu.Item>
                                <DropdownMenu.Item className="menu-item" onSelect={() => void navigate('/me/applications')}>인증·등급 신청 내역</DropdownMenu.Item>
                                {me.role === 'manager' && <DropdownMenu.Item className="menu-item" onSelect={() => void navigate('/manage')}>매니저 관리</DropdownMenu.Item>}
                                <DropdownMenu.Separator className="menu-sep" />
                                <DropdownMenu.Item className="menu-item" onSelect={logout}>로그아웃</DropdownMenu.Item>
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root> : <button type="button" className="header-link header-login" onClick={() => openAuth('login')}>로그인 / 회원가입</button>}
                    <button type="button" className="btn btn-primary btn-sm header-write" onClick={() => go(write)}><PenLine size={16} />글쓰기</button>
                </div>
            </div>
        </header>
        <main id="main">
            <Suspense fallback={<div className="container page"><SkeletonRows /></div>}>
                {page === '' ? <Home />
                    : page === 'trade' ? <Board />
                    : page === 'posts' ? <Detail key={parts[1]} id={parts[1]} />
                    : page === 'write' ? <Editor key={'write' + (me?.id || '')} />
                    : page === 'edit' ? <Editor key={'edit' + parts[1] + (me?.id || '')} id={parts[1]} />
                    : page === 'chat' ? <Chat id={parts[1]} />
                    : page === 'profile' ? <Profile key={parts[1]} id={parts[1]} />
                    : page === 'me' ? <Mine tab={parts[1] || 'posts'} />
                    : page === 'manage' ? <Manage tab={parts[1] || 'applications'} />
                    : page === 'guide' ? <Guide />
                    : <NotFound />}
            </Suspense>
        </main>
        {page !== 'chat' && <footer className="footer">
            <div className="container footer-inner">
                <div><strong>좀비고 거래소</strong>회원끼리 직접 거래하는 커뮤니티입니다. 게임 운영사와 관계가 없으며 결제나 거래 보증을 하지 않습니다.</div>
                <div className="footer-links"><Link to="/guide">공지·이용 안내</Link><button type="button" onClick={() => openApply()}>인증·등급</button><a href="https://awesomepiece.com/management.html" target="_blank" rel="noreferrer">게임 운영정책</a></div>
            </div>
        </footer>}
        <nav className="bottom-nav" aria-label="하단 메뉴">
            <Link to="/" aria-current={page === '' ? 'page' : undefined}><House size={22} />홈</Link>
            <Link to="/trade?kind=sell" aria-current={page === 'trade' ? 'page' : undefined}><LayoutList size={22} />거래</Link>
            <button type="button" onClick={() => go(write)} aria-current={page === 'write' ? 'page' : undefined}><PenLine size={22} />글쓰기</button>
            <button type="button" onClick={() => go('/chat')} aria-current={page === 'chat' ? 'page' : undefined}><MessageCircle size={22} />채팅{unread > 0 && <b className="badge-count">{unread > 99 ? '99+' : unread}</b>}</button>
            <button type="button" onClick={() => me ? void navigate('/profile/' + me.id) : openAuth('login')} aria-current={page === 'profile' || page === 'me' ? 'page' : undefined}><UserRound size={22} />내 정보</button>
        </nav>
        <AuthModal />
        <ApplyModal />
    </>;
}

function NotFound() {
    return <div className="container page"><div className="empty"><CIcon name="warning" size={56} /><h3>페이지를 찾을 수 없습니다</h3><p>주소가 바뀌었거나 삭제된 페이지입니다.</p><Link className="btn btn-primary" to="/">홈으로</Link></div></div>;
}
