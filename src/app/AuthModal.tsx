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
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const register = authMode === 'register';
    useEffect(() => { setError(''); setPassword(''); }, [authMode]);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy) return;
        setBusy(true); setError('');
        try {
            const d = await api<{ user: User }>('auth/' + (register ? 'register' : 'login'), 'POST', { username, password, nickname });
            setPassword('');
            finishAuth(d.user);
            toast(register ? `${d.user.nickname}님, 가입을 환영합니다.` : `${d.user.nickname}님, 반갑습니다.`);
        } catch (err) { setError(errorText(err)); }
        finally { setBusy(false); }
    }

    return <Modal open={!!authMode} onClose={() => { if (!busy) closeAuth(); }} title={register ? '회원가입' : '로그인'}
        description={register ? '아이디, 비밀번호, 닉네임만 있으면 바로 거래할 수 있어요.' : '로그인하면 30일 동안 유지됩니다.'}>
        <form className="form-stack" onSubmit={submit}>
            <label className="field"><span className="field-label">아이디</span>
                <input className="input" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="영문 소문자, 숫자, 밑줄 4~24자" minLength={4} maxLength={24} required autoFocus /></label>
            {register && <label className="field"><span className="field-label">닉네임</span>
                <input className="input" autoComplete="nickname" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="2~16자" minLength={2} maxLength={16} required /></label>}
            <label className="field"><span className="field-label">비밀번호</span>
                <input className="input" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="8자 이상" minLength={8} maxLength={128} required /></label>
            {error && <p className="field-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? <LoaderCircle size={20} className="spin" /> : register ? '가입하기' : '로그인'}</button>
        </form>
        <p className="auth-switch">{register ? '이미 계정이 있나요?' : '아직 회원이 아닌가요?'}
            <button type="button" disabled={busy} onClick={() => openAuth(register ? 'login' : 'register')}>{register ? '로그인' : '회원가입'}</button></p>
    </Modal>;
}
