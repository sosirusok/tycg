import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { User } from '../../shared/market';
import type { TrialState } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../app/state';

// /manager-login: the reserved manager account's ID/password sign-in (POST auth/manager-login). No link
// on the site leads here; members sign in with Naver.
export default function ManagerLogin() {
    const { finishAuth } = useApp();
    const [username, setUsername] = useState(''), [password, setPassword] = useState('');
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true); setError('');
        try {
            const d = await api<{ user: User; trial?: TrialState | null }>('auth/manager-login', 'POST', { username, password });
            setPassword('');
            finishAuth(d.user, d.trial);
            void navigate('/manage', { replace: true });
        } catch (err) { setError(errorText(err)); }
        finally { setBusy(false); }
    }
    return <div className="container page naver-page">
        <section className="card card-pad naver-card">
            <h1 className="naver-title">매니저 로그인</h1>
            <form className="form-stack" onSubmit={submit}>
                <label className="field"><span className="field-label">아이디</span>
                    <input className="input" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} minLength={4} maxLength={24} required autoFocus /></label>
                <label className="field"><span className="field-label">비밀번호</span>
                    <input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} maxLength={128} required /></label>
                {error && <p className="field-error" role="alert">{error}</p>}
                <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username.trim() || !password}>{busy ? <LoaderCircle size={20} className="spin" /> : '로그인'}</button>
            </form>
        </section>
    </div>;
}
