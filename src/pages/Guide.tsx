import { useEffect, useState } from 'react';
import { dateText } from '../../shared/market';
import { BADGES, GRADES } from '../../shared/membership';
import { api } from '../lib/api';
import { useApp } from '../app/state';
import { CIcon } from '../components/ui';

type Notice = { id: number; title: string; body: string; created_at: number };

// Row text is the final 거래 순서 wording (WP18 later restyles the list itself).
const STEPS = [
    ['문의', '채팅하기로 문의. 판매 글은 제시도 가능.'],
    ['인증 확인', '닉네임 옆 인증 표시 확인. 필요하면 계좌·이중창 인증 요청.'],
    ['더치트 조회', '입금 전 더치트(thecheat.co.kr)로 상대 전번·계좌 조회.'],
    ['입금', '입금 후 채팅에 입금자명, 시간 남기기.'],
    ['계정 넘김', '입금 확인 후 계정 전달. 받은 쪽은 바로 비번·전번·보안 메일 변경.'],
    ['거래완료', '글을 거래완료로 변경.'],
] as const;

export default function Guide() {
    const { openApply, config } = useApp();
    const [notices, setNotices] = useState<Notice[] | null>(null);
    const [open, setOpen] = useState<number | null>(() => Number(location.hash.replace('#notice-', '')) || null);
    useEffect(() => { api<{ notices: Notice[] }>('notices').then(d => setNotices(d.notices)).catch(() => setNotices([])); }, []);
    useEffect(() => { if (notices && location.hash.startsWith('#notice-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' }); }, [notices]);

    return <div className="container page guide">
        <h1 className="page-title">공지</h1>

        <section className="section">
            <h2 className="section-title">공지사항</h2>
            {notices === null ? <div className="skeleton mt-16" style={{ height: 120 }} /> : notices.length ? <ul className="notice-acc">{notices.map(n => <li key={n.id} id={'notice-' + n.id}>
                <button type="button" aria-expanded={open === n.id} onClick={() => setOpen(open === n.id ? null : n.id)}><span className="grow">{n.title}</span><span className="muted small">{dateText(n.created_at)}</span></button>
                {open === n.id && <p className="body-text">{n.body}</p>}
            </li>)}</ul> : <p className="muted mt-16">등록된 공지가 없습니다.</p>}
        </section>

        <section className="section">
            <h2 className="section-title">거래 순서</h2>
            <ol className="steps">{STEPS.map(([title, text], i) => <li key={title}><b>{i + 1}. {title}</b><p>{text}</p></li>)}</ol>
        </section>

        <section className="section">
            <div className="section-head"><h2 className="section-title">인증</h2><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'badge', target: 'identity' })}>인증 신청하기</button></div>
            <div className="guide-cards">{BADGES.map(b => <div key={b.id} className="card card-pad"><CIcon name={b.icon} size={36} /><h3 className="mt-12">{b.name}</h3><p className="mt-8">{b.summary}</p><p className="muted small mt-8">제출: {b.requirements.join(', ')}</p></div>)}</div>
        </section>

        <section className="section">
            <div className="section-head"><h2 className="section-title">등급</h2><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'grade', target: 'plus', plan: 'permanent' })}>등급 신청하기</button></div>
            <table className="grade-price">
                <thead><tr><th>등급</th><th>영구</th><th>6개월</th></tr></thead>
                <tbody>{GRADES.map(g => <tr key={g.id}>
                    <td><span className="row"><CIcon name={g.icon} size={22} />{g.name}</span></td>
                    {g.plans.length ? <><td>{g.plans.find(p => p.id === 'permanent')?.price.toLocaleString('ko-KR') + '원'}</td><td>{g.plans.find(p => p.id === '6m') ? g.plans.find(p => p.id === '6m')!.price.toLocaleString('ko-KR') + '원' : '-'}</td></>
                        : <td colSpan={2} className="grade-note">{g.note}</td>}
                </tr>)}</tbody>
            </table>
            <p className="muted small mt-12">{config.paymentNotice ? `입금 안내: ${config.paymentNotice}` : '입금 계좌는 신청 후 채팅으로 안내합니다.'} 입금 확인 후 매니저가 지급합니다.</p>
        </section>

        <section className="section">
            <h2 className="section-title">주의사항</h2>
            <ul className="rules">
                <li>사이트는 결제 대행, 안전거래, 거래 보증을 하지 않습니다. 거래 책임은 당사자에게 있습니다.</li>
                <li>계정 거래와 대리는 <a href="https://awesomepiece.com/management.html" target="_blank" rel="noreferrer">게임 운영정책</a>상 정지될 수 있습니다.</li>
                <li>비번, 인증번호는 글에 쓰지 마세요.</li>
                <li>쿠폰 코드는 입금 확인 후 전달하세요.</li>
                <li>사기 의심 글은 신고해 주세요. 확인 후 숨김 또는 삭제합니다.</li>
            </ul>
        </section>
    </div>;
}
