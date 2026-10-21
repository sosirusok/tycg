import { Modal } from '../components/ui';
import { useApp } from './state';

// The Naver 'N' mark (white on the green button), as inline SVG.
export function NaverMark() {
    return <svg className="naver-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path fill="#fff" d="M10.85 8.56 4.97 0H0v16h5.15V7.44L11.03 16H16V0h-5.15z" />
    </svg>;
}

// The address that starts 네이버 로그인 and comes back to `next` (this page by default).
export function naverStart(next = location.pathname + location.search) {
    return '/api/auth/naver/start?next=' + encodeURIComponent(next);
}

// 네이버로 로그인: the official green button (the one exception to the single brand colour). It is a full
// page move, so the site comes back to the same page after Naver.
export function NaverButton({ next, label = '네이버로 로그인', disabled = false }: { next?: string; label?: string; disabled?: boolean }) {
    if (disabled) return <button type="button" className="btn btn-lg btn-block btn-naver" disabled><NaverMark />{label}</button>;
    return <a className="btn btn-lg btn-block btn-naver" href={naverStart(next)}><NaverMark />{label}</a>;
}

// Login and sign-up are one step: a new Naver account picks a nickname on the next screen (/naver).
export function AuthModal() {
    const { authMode, closeAuth, config } = useApp();
    const ready = config.naverLogin !== false;
    return <Modal open={!!authMode} onClose={closeAuth} title="로그인">
        <div className="form-stack auth-naver">
            <NaverButton disabled={!ready} />
            <p className="auth-note">{ready ? '처음이면 닉네임만 정하면 가입됩니다.' : '네이버 로그인 설정이 아직 끝나지 않았습니다.'}</p>
        </div>
    </Modal>;
}
