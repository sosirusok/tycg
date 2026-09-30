import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { User } from '../../shared/market';
import { api, errorText } from '../lib/api';
import { Modal } from '../components/ui';
import { useApp } from './state';

export function AuthModal() {
    const { authMode, openAuth, closeAuth, finishAuth } = useApp();
    const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [nickname, setNickname] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const register = authMode === 'register';
    // Sign-up asks for the password twice; a typo would otherwise lock the new member out.
    const mismatch = register && confirm !== '' && confirm !== password;
    useEffect(() => { setError(''); setPassword(''); setConfirm(''); }, [authMode]);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy || register && password !== confirm) return;
        setBusy(true); setError('');
        try {
            const d = await api<{ user: User }>('auth/' + (register ? 'register' : 'login'), 'POST', { username, password, nickname });
            setPassword(''); setConfirm('');
            finishAuth(d.user);
            if (register) toast('가입 완료');
        } catch (err) { setError(errorText(err)); }
        finally { setBusy(false); }
    }

    return <Modal open={!!authMode} onClose={() => { if (!busy) closeAuth(); }} title={register ? '회원가입' : '로그인'}>
        <form className="form-stack" onSubmit={submit}>
            <label className="field"><span className="field-label">아이디</span>
                <input className="input" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="영문 소문자, 숫자, _ 4~24자" minLength={4} maxLength={24} required autoFocus /></label>
            {register && <label className="field"><span className="field-label">닉네임</span>
                <input className="input" autoComplete="nickname" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="2~16자" minLength={2} maxLength={16} required /></label>}
            <label className="field"><span className="field-label">비밀번호</span>
                <input className="input" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="8자 이상" minLength={8} maxLength={128} required /></label>
            {register && <div className="field"><label className="field-label" htmlFor="auth-confirm">비밀번호 확인</label>
                <input id="auth-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} minLength={8} maxLength={128} required
                    aria-invalid={mismatch} aria-describedby={mismatch ? 'auth-confirm-error' : undefined} />
                {mismatch && <span id="auth-confirm-error" className="field-error" role="alert">비밀번호가 서로 다릅니다.</span>}</div>}
            {error && <p className="field-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || mismatch}>{busy ? <LoaderCircle size={20} className="spin" /> : register ? '가입하기' : '로그인'}</button>
        </form>
        <p className="auth-switch"><button type="button" disabled={busy} onClick={() => openAuth(register ? 'login' : 'register')}>{register ? '로그인' : '회원가입'}</button></p>
    </Modal>;
}
