import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { dateText, wonText } from '../../shared/market';
import { BADGES, GRADES, PERKS, SITE_RULES, gapText, gradePriority, type GradeInfo } from '../../shared/membership';
import { api } from '../lib/api';
import { useApp } from '../app/state';
import { CIcon } from '../components/ui';

type Notice = { id: number; title: string; body: string; created_at: number };

const STEPS = [
    ['문의', '채팅하기로 문의. 판매 글은 제시도 가능.'],
    ['인증 확인', '닉네임 옆 인증 표시 확인. 필요하면 계좌·이중창 인증 요청.'],
    ['더치트 조회', '입금 전 더치트(thecheat.co.kr)로 상대 전번·계좌 조회.'],
    ['입금', '입금 후 채팅에 입금자명, 시간 남기기.'],
    ['계정 넘김', '입금 확인 후 계정 전달. 받은 쪽은 바로 비번·전번·보안 메일 변경.'],
    ['거래완료', '거래완료 누르고 거래한 회원 선택. 상대가 확인하면 거래 기록에 남음.'],
] as const;

// Grade benefit table: every number comes from PERKS (the limits the Worker enforces) and every
// price from GRADES, so the guide cannot drift from the rules. 관리자 is described under the table.
// A cell may hold two lines (영구 and 6개월 prices), each its own line.
const TABLE_GRADES = GRADES.filter(g => g.id !== 'admin');
const NAME_STYLE: Record<string, string> = { normal: '-', plus: '회색 테두리', premium: '파란 테두리', elite: '파란 바탕' };
const BENEFIT_ROWS: [string, (g: GradeInfo) => string | string[]][] = [
    ['가격', g => g.plans.length ? g.plans.map(p => `${p.label} ${wonText(p.price)}`) : '무료'],
    ['끌올 보관', g => `${PERKS[g.id].bumpMax}개`],
    ['끌올 충전', g => `${gapText(PERKS[g.id].bumpRefillMinutes)}마다 1개`],
    ['같은 글 끌올 간격', g => gapText(PERKS[g.id].bumpGapMinutes)],
    ['게시판 상단', g => PERKS[g.id].boardSlots ? `${PERKS[g.id].boardSlots}자리` : '-'],
    ['홈 추천 매물', g => PERKS[g.id].homeShelf ? 'O' : '-'],
    ['닉네임 표시', g => NAME_STYLE[g.id] || '-'],
    // 중개·가측 (WP65): free requests per month (shared between the two), handling order, and the
    // 운영진 가측가 on the post for every grade (paid requests too).
    ['무료 중개·가측 (매월 1일 초기화)', g => { const n = PERKS[g.id].serviceCoupons; return !n ? '-' : Number.isFinite(n) ? `월 ${n}회` : '무제한'; }],
    ['중개·가측 처리 순서', g => `${gradePriority(g.id)}순위`],
    ['운영진 가측가 표시', () => 'O'],
];
// What the free 일반 grade already has: every cafe basic, with anti-flood ceilings only (SITE_RULES).
const FREE_ITEMS = [
    `사진 글당 ${SITE_RULES.photosPerPost}장`,
    `거래중 글 ${SITE_RULES.openPosts}개`,
    `하루 새 글 ${SITE_RULES.postsPerDay}개`,
    `끌올 ${PERKS.normal.bumpMax}개 · ${gapText(PERKS.normal.bumpRefillMinutes)}마다 충전`,
    '채팅·제시',
    '찜',
    `검색 조건 저장 ${SITE_RULES.savedSearches}개`,
    '거래 기록·후기',
    '신고·차단',
];

export default function Guide() {
    const { openApply, config } = useApp();
    const [notices, setNotices] = useState<Notice[] | null>(null);
    const [open, setOpen] = useState<number | null>(() => Number(location.hash.replace('#notice-', '')) || null);
    useEffect(() => { api<{ notices: Notice[] }>('notices').then(d => setNotices(d.notices)).catch(() => setNotices([])); }, []);
    // The notices above change the page height when they load, so a #notice-… or #grade link
    // scrolls once they are in.
    useEffect(() => {
        if (!notices) return;
        if (location.hash.startsWith('#notice-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
        else if (location.hash === '#grade') document.getElementById('grade')?.scrollIntoView({ block: 'start' });
    }, [notices]);

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
            <ol className="steps">{STEPS.map(([title, text], i) => <li key={title}><span className="step-num">{i + 1}</span><b>{title}</b><p>{text}</p></li>)}</ol>
            <ul className="grade-notes">
                <li>완료한 글은 되돌릴 수 없습니다.</li>
                <li>거래 횟수와 거금은 상대가 확인한 거래만 셉니다. 같은 회원과의 거래는 30일에 1번만 셉니다.</li>
                <li>거금은 글에 올린 가격·MAX·제시 안에서만 셉니다.</li>
            </ul>
        </section>

        <section className="section">
            <div className="section-head"><h2 className="section-title">인증</h2><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'badge', target: 'identity' })}>인증 신청하기</button></div>
            <div className="guide-cards">{BADGES.map(b => <div key={b.id} className="card card-pad"><CIcon name={b.icon} size={36} /><h3 className="mt-12">{b.name}</h3><p className="mt-8">{b.summary}</p><p className="muted small mt-8">제출: {b.requirements.join(', ')}</p></div>)}</div>
        </section>

        <section className="section" id="grade">
            <div className="section-head"><h2 className="section-title">등급</h2><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'grade', target: 'plus', plan: 'permanent' })}>등급 신청하기</button></div>
            <div className="table-scroll">
                <table className="grade-benefits">
                    <thead><tr><th scope="col"><span className="sr-only">항목</span></th>{TABLE_GRADES.map(g => <th scope="col" key={g.id}>{g.name}</th>)}</tr></thead>
                    <tbody>{BENEFIT_ROWS.map(([label, cell]) => <tr key={label}>
                        <th scope="row">{label}</th>
                        {TABLE_GRADES.map(g => { const v = cell(g); return <td key={g.id}>{Array.isArray(v) ? v.map(line => <span key={line} className="cell-line">{line}</span>) : v}</td>; })}
                    </tr>)}</tbody>
                </table>
            </div>
            <div className="grade-free">
                <h3>일반 (무료)</h3>
                <ul>{FREE_ITEMS.map(item => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}</ul>
            </div>
            <ul className="grade-notes">
                <li>관리자: 매니저가 지정. 이용 혜택은 엘리트와 같습니다. 인증/등급 지급은 매니저만 합니다.</li>
                <li>하루 새 글 {SITE_RULES.freshPerDay}개까지 새 글로 올라가고, 그 뒤로는 끌올 1개씩 씁니다.</li>
                <li>같은 매물을 다시 올리면 끌올 1개로 칩니다. 끌올 간격 안이면 이전 자리에 올라갑니다.</li>
                <li>같은 매물: 같은 제목, 절반 넘게 같은 사진, 또는 래더·스킨·팬텀 등 매물 정보 3가지 이상이 같은 글입니다.</li>
                <li>중개·가측: 내 판매·교환 계정 글의 더보기에서 가측 신청, 채팅의 더보기에서 중개 신청. 무료 횟수가 없으면 유료이며 수수료는 매니저가 채팅으로 안내합니다. 플러스 체험 중에는 무료 횟수가 없습니다.</li>
                <li>운영진 가측가는 글을 수정하면 표시되지 않습니다.</li>
                <li>{config.paymentNotice ? `입금 안내: ${config.paymentNotice}` : '입금 계좌는 신청 후 채팅으로 안내합니다.'} 입금 확인 후 매니저가 지급합니다.</li>
            </ul>
        </section>

        <section className="section">
            <h2 className="section-title">주의사항</h2>
            <ul className="rules">
                <li>사이트는 결제 대행, 안전거래, 거래 보증을 하지 않습니다. 거래 책임은 당사자에게 있습니다.</li>
                <li>계정 거래와 대리는 <a href="https://awesomepiece.com/management.html" target="_blank" rel="noreferrer">게임 운영정책</a>상 정지될 수 있습니다.</li>
                <li>비번과 인증번호는 누구에게도 알려 주지 않습니다.</li>
                <li>쿠폰 코드는 입금 확인 후 전달하세요.</li>
                <li>사기 의심 글은 신고해 주세요. 확인 후 숨김 또는 삭제합니다.</li>
                <li>중개는 운영진 또는 신용인에게만 맡깁니다.</li>
                <li>다른 거래 카페·밴드 홍보 링크는 금지입니다.</li>
            </ul>
        </section>
    </div>;
}
