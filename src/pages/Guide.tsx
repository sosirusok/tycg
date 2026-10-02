import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { dateText, wonText } from '../../shared/market';
import { AD_TEXT, AUTO_TEXT, BADGES, BULK_MAX, DROP_TEXT, PERKS, PROVIDER_TEXT, REPORT_TEXT, SITE_RULES, gapText, gradeInfo } from '../../shared/membership';
import { BENEFIT_ROWS, PAID_GRADES, TABLE_GRADES, gradeExtras, gradeHook, monthly, vsNormal, type PaidGrade } from '../../shared/benefits';
import { api } from '../lib/api';
import { Link } from '../lib/router';
import { useApp } from '../app/state';
import { CIcon } from '../components/ui';
import { EarnBlock } from '../components/ProviderCard';

type Notice = { id: number; title: string; body: string; created_at: number };

const STEPS = [
    ['문의', '채팅하기로 문의. 판매 글은 제시도 가능.'],
    ['인증 확인', '닉네임 옆 인증 표시 확인. 필요하면 계좌·이중창 인증 요청.'],
    ['더치트 조회', '입금 전 더치트(thecheat.co.kr)로 상대 전번·계좌 조회.'],
    ['입금', '입금 후 채팅에 입금자명, 시간 남기기.'],
    ['계정 넘김', '입금 확인 후 계정 전달. 받은 쪽은 바로 비번·전번·보안 메일 변경.'],
    ['거래완료', '거래완료 누르고 거래한 회원 선택. 상대가 확인하면 거래 기록에 남음.'],
] as const;

// What the free 일반 grade already has (WP61 change 2): every cafe basic, with anti-flood ceilings only.
const FREE_ITEMS = [
    `사진 글당 ${SITE_RULES.photosPerPost}장`,
    '댓글·답글',
    '채팅·제시',
    '찜·알림',
    `키워드·게시판 알림 ${SITE_RULES.keywordAlerts}개`,
    '판매자 구독',
    `끌올 ${PERKS.normal.bumpMax}개 · ${gapText(PERKS.normal.bumpRefillMinutes)}마다 충전`,
    `하루 새 글 우선 ${SITE_RULES.freshPerDay}개`,
    '링크 자동 연결',
    '거래 기록·후기',
    '공유·카톡 미리보기',
    // WP58 and WP63: every grade.
    `모두 끌올 · 일괄 변경 ${BULK_MAX}개`,
    '다시 올리기 · 복사해서 새 글',
    '맞는 구매 글·판매 글 링크',
    '인기순 정렬',
];
// What the site does better than a cafe board, for every grade.
const CAFE_ITEMS = ['끌올 버튼 (링크 다시 올리기 없음)', '끌올 가능 알림', '가격 내림 표시', '제시 기록', '상대가 확인한 거래 기록', '인증 표시', '같은 회원 글 접기', '광고는 목록 순서와 별개'];

// A table cell: 'O' as a check mark (the letter stays for screen readers), '무제한' in bold.
function Cell({ v }: { v: string }) {
    if (v === 'O' || v.startsWith('O ')) return <><Check size={16} className="cell-check" aria-hidden="true" /><span className="sr-only">O</span>{v.slice(1)}</>;
    if (v.includes('무제한')) { const [a, b] = v.split('무제한'); return <>{a}<b>무제한</b>{b}</>; }
    return <>{v}</>;
}
const metalOf = (g: PaidGrade) => g === 'elite' ? 'gold' : g === 'premium' ? 'silver' : 'bronze';

// The paid grade cards (owner requests 2026-10-01 and 2026-10-02): the metal accent (엘리트 gold with the
// shimmer and '모든 혜택'), the price with 월 환산 for 6개월, the hook in big type, at most 3 '일반 대비' lines and
// '혜택 N가지' (the table rows where the grade beats 일반), all from PERKS and GRADES.
function GradeCards({ onApply }: { onApply: (g: PaidGrade) => void }) {
    return <div className="grade-cards">{PAID_GRADES.map(g => {
        const info = gradeInfo(g), vs = vsNormal(g);
        return <article key={g} className={'grade-card grade-card-' + metalOf(g)}>
            <div className="grade-card-head"><CIcon name={info.icon} size={28} /><h3>{info.name}</h3>{g === 'elite' && <span className="grade-card-all">모든 혜택</span>}</div>
            <ul className="grade-card-price">{info.plans.map(p => <li key={p.id}><b>{p.label} {wonText(p.price)}</b>{p.months ? <span> · 월 환산 {monthly(p.price, p.months)}</span> : null}</li>)}</ul>
            <p className="grade-card-hook">{gradeHook(g)}</p>
            {vs.length > 0 && <><p className="grade-card-vs-title">일반 대비</p>
                <ul className="grade-card-vs">{vs.map(line => <li key={line}><Check size={15} aria-hidden="true" />{line}</li>)}</ul></>}
            <div className="grade-card-foot"><a href="#grade-table" className="grade-card-count">혜택 {gradeExtras(g).length}가지</a>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onApply(g)}>{info.name} 신청</button></div>
        </article>;
    })}</div>;
}

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
                <li>확인된 거래는 프로필 거래 기록에 남고, 완료된 글에는 거래가가 표시됩니다.</li>
                <li><Link to="/providers?type=broker" className="guide-link">{PROVIDER_TEXT.guide}</Link></li>
            </ul>
        </section>

        <section className="section">
            <div className="section-head"><h2 className="section-title">인증</h2><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'badge', target: 'identity' })}>인증 신청하기</button></div>
            <div className="guide-cards">{BADGES.map(b => <div key={b.id} className="card card-pad"><CIcon name={b.icon} size={36} /><h3 className="mt-12">{b.name}</h3><p className="mt-8">{b.summary}</p><p className="muted small mt-8">제출: {b.requirements.join(', ')}</p></div>)}</div>
        </section>

        <section className="section" id="grade">
            <div className="section-head"><h2 className="section-title">등급</h2><button type="button" className="btn btn-line btn-sm" onClick={() => openApply({ kind: 'grade', target: 'plus', plan: 'permanent' })}>등급 신청하기</button></div>
            <GradeCards onApply={g => openApply({ kind: 'grade', target: g, plan: 'permanent' })} />
            <div className="table-scroll" id="grade-table">
                <table className="grade-benefits">
                    <thead><tr><th scope="col"><span className="sr-only">항목</span></th>{TABLE_GRADES.map(g => <th scope="col" key={g}>{gradeInfo(g).name}{g === 'elite' && <span className="grade-card-all">모든 혜택</span>}</th>)}</tr></thead>
                    <tbody>{BENEFIT_ROWS.map(row => <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        {TABLE_GRADES.map(g => { const v = row.cell(g); return <td key={g} className={g === 'elite' ? 'is-elite' : undefined}>{Array.isArray(v) ? v.map(line => <span key={line} className="cell-line">{line}</span>) : <Cell v={v} />}</td>; })}
                    </tr>)}</tbody>
                </table>
            </div>
            <EarnBlock earn={config.earn} className="mt-16" />
            <div className="grade-free">
                <h3>일반 (무료)</h3>
                <ul>{FREE_ITEMS.map(item => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}</ul>
            </div>
            <div className="grade-free">
                <h3>카페보다 편한 점</h3>
                <ul>{CAFE_ITEMS.map(item => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}</ul>
            </div>
            <ul className="grade-notes">
                <li>관리자: 매니저가 지정. 이용 혜택은 엘리트와 같습니다. 인증/등급 지급은 매니저만 합니다.</li>
                <li>거래중 글 {SITE_RULES.openPosts}개, 하루 새 글 {SITE_RULES.postsPerDay}개는 도배 방지 상한이며 모든 등급이 같습니다.</li>
                <li>자동 기능은 {PERKS.plus.pauseDays}일 동안 접속이 없으면 멈추고 접속하면 다시 시작됩니다. (엘리트 {PERKS.elite.pauseDays}일)</li>
                <li>{AD_TEXT.sortNote}</li>
                <li>{AD_TEXT.orderNote}</li>
                <li>{AUTO_TEXT.reserve}</li>
                <li>{AUTO_TEXT.capped}</li>
                <li>{DROP_TEXT.hold}</li>
                <li>하루 새 글 {SITE_RULES.freshPerDay}개까지 새 글로 올라가고, 그 뒤로는 끌올 1개씩 씁니다.</li>
                <li>같은 매물을 다시 올리면 끌올 1개로 칩니다. 끌올 간격 안이면 이전 자리에 올라갑니다.</li>
                <li>같은 매물: 같은 제목, 절반 넘게 같은 사진, 또는 래더·스킨·팬텀 등 매물 정보 3가지 이상이 같은 글입니다.</li>
                <li>중개/가측 탭의 같은 등급 안 순서는 접속 중인 회원 먼저, 그다음 3시간마다 바뀌는 무작위 순서입니다.</li>
                <li>{REPORT_TEXT.urgentNote}</li>
                <li>{REPORT_TEXT.demoteNote}</li>
                <li>{config.paymentNotice ? `입금 안내: ${config.paymentNotice}` : '입금 계좌는 신청 후 채팅으로 안내합니다.'} 입금 확인 후 매니저가 지급합니다.</li>
            </ul>
        </section>

        {/* 홈 화면 앱과 웹 푸시 (WP64): every grade; the bar '알림 켜기' shows after a chat message or an 알림. */}
        <section className="section">
            <h2 className="section-title">휴대폰 알림</h2>
            <ul className="grade-notes">
                <li>아이폰은 iOS 16.4 이상에서 홈 화면에 추가한 뒤 알림을 켤 수 있습니다.</li>
                <li>{'사파리 공유 버튼 > 홈 화면에 추가'}</li>
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
                <li>중개는 중개 인증 회원에게 맡기세요. 거래 대금은 사이트를 거치지 않습니다.</li>
                <li>다른 거래 카페·밴드 홍보 링크는 금지입니다.</li>
            </ul>
        </section>
    </div>;
}
