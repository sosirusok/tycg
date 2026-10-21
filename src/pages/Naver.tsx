import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { User } from '../../shared/market';
import type { TrialState } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { useApp } from '../app/state';
import { NaverButton } from '../app/AuthModal';
import { SkeletonRows } from '../components/ui';

// What /api/auth/naver/callback and /start mean by /naver?error=<code>.
const NAVER_ERRORS: Record<string, string> = {
    config: '네이버 로그인 설정이 아직 끝나지 않았습니다.',
    state: '로그인 요청이 만료되었습니다. 다시 로그인해 주세요.',
    denied: '네이버 로그인이 취소되었습니다.',
    naver: '네이버 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    busy: '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
    taken: '이미 다른 회원에게 연결된 네이버 계정입니다.',
};
const PENDING_GONE = '네이버 로그인 시간이 지났습니다. 다시 로그인해 주세요.';

type Pending = { pending: boolean; trial?: boolean };
type Done = { user: User; trial?: TrialState | null; next?: string };

// /naver: 가입 마무리 after a first 네이버 로그인 (닉네임 and the 이용 규칙), or 기존 계정 연결 for a member
// who signed up with an ID and password before. The Naver id travels in a signed HttpOnly cookie only.
export default function Naver() {
    const { me, finishAuth } = useApp();
    const { params } = useLocation();
    const error = params.get('error');
    const [info, setInfo] = useState<Pending | null>(null);
    const [mode, setMode] = useState<'join' | 'link'>('join');
    const [nickname, setNickname] = useState(''), [agree, setAgree] = useState(false);
    const [username, setUsername] = useState(''), [password, setPassword] = useState('');
    const [formError, setFormError] = useState(''), [busy, setBusy] = useState(false);

    useEffect(() => {
        if (error) return;
        api<Pending>('auth/naver/pending').then(setInfo).catch(() => setInfo({ pending: false }));
    }, [error]);
    useEffect(() => { setFormError(''); }, [mode]);

    function done(d: Done, line: string) {
        finishAuth(d.user, d.trial);
        // The trial popup that follows already confirms the sign-up.
        if (line && !d.trial?.popup) toast(line);
        void navigate(d.next || '/', { replace: true });
    }
    async function join(e: FormEvent) {
        e.preventDefault();
        if (busy || !agree) return;
        setBusy(true); setFormError('');
        try { done(await api<Done>('auth/naver/finish', 'POST', { nickname, agree }), '가입 완료'); }
        catch (err) { setFormError(errorText(err)); }
        finally { setBusy(false); }
    }
    async function link(e: FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true); setFormError('');
        try { const d = await api<Done>('auth/naver/link', 'POST', { username, password }); setPassword(''); done(d, '연결 완료'); }
        catch (err) { setFormError(errorText(err)); }
        finally { setBusy(false); }
    }

    if (!error && !info) return <div className="container page"><SkeletonRows /></div>;
    if (error || !info?.pending) {
        return <div className="container page naver-page">
            <section className="card card-pad naver-card">
                <h1 className="naver-title">네이버 로그인</h1>
                <p className="naver-message" role="alert">{(error && NAVER_ERRORS[error]) || PENDING_GONE}</p>
                {me ? <Link className="btn btn-line btn-lg btn-block" to="/">홈으로</Link> : <NaverButton next="/" />}
            </section>
        </div>;
    }

    return <div className="container page naver-page">
        <section className="card card-pad naver-card">
            <h1 className="naver-title">{mode === 'join' ? '가입 마무리' : '기존 계정 연결'}</h1>
            {mode === 'join' ? <form className="form-stack" onSubmit={join}>
                {info.trial && <p className="naver-trial">가입하면 플러스 7일 무료</p>}
                <div className="field"><label className="field-label" htmlFor="naver-nickname">닉네임</label>
                    <input id="naver-nickname" className="input" autoComplete="nickname" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="2~16자" minLength={2} maxLength={16} required autoFocus aria-describedby="naver-nickname-hint" />
                    <span id="naver-nickname-hint" className="field-hint">30일에 한 번 변경 가능</span></div>
                <div className="naver-rules">
                    <ul className="rules">
                        <li>사이트는 결제 대행, 안전거래, 거래 보증을 하지 않습니다. 거래 책임은 당사자에게 있습니다.</li>
                        <li>사기, 허위 매물, 도배 글은 숨김 또는 이용 정지됩니다.</li>
                        <li>네이버 정보는 회원 구분에만 쓰이고 공개되지 않습니다.</li>
                    </ul>
                    <label className="check"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} required />이용 규칙 동의</label>
                </div>
                {formError && <p className="field-error" role="alert">{formError}</p>}
                <button className="btn btn-primary btn-lg btn-block" disabled={busy || !agree || nickname.trim().length < 2}>{busy ? <LoaderCircle size={20} className="spin" /> : '가입'}</button>
            </form> : <form className="form-stack" onSubmit={link}>
                <p className="naver-desc">예전 아이디로 가입한 계정을 이 네이버 계정에 한 번 연결합니다. 연결 후에는 네이버로만 로그인합니다.</p>
                <label className="field"><span className="field-label">아이디</span>
                    <input className="input" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} minLength={4} maxLength={24} required autoFocus /></label>
                <label className="field"><span className="field-label">비밀번호</span>
                    <input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} maxLength={128} required /></label>
                {formError && <p className="field-error" role="alert">{formError}</p>}
                <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username.trim() || !password}>{busy ? <LoaderCircle size={20} className="spin" /> : '연결'}</button>
            </form>}
            <p className="auth-switch">{mode === 'join'
                ? <button type="button" disabled={busy} onClick={() => setMode('link')}>기존 계정 연결</button>
                : <button type="button" disabled={busy} onClick={() => setMode('join')}>새로 가입</button>}</p>
        </section>
    </div>;
}
