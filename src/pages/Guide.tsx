import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { TEMPLATE_VARS, dateText, wonText } from '../../shared/market';
import { AD_TEXT, AUTO_TEXT, BADGES, BULK_MAX, CHAT_AUTO_TEXT, DROP_TEXT, GRADES, MATCH_TEXT, PERKS, REPORT_TEXT, SITE_RULES, STATS_GUIDE, STATS_TEXT, TITLE_STYLE_NAMES, dropGuideText, filterAlertText, gapText, gradeInfo, linkPreviewAllowed, matchGuideText, priorityCell, titleTier, type GradeInfo } from '../../shared/membership';
import { styleRank } from '../../shared/richtext';
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
const STYLE_LADDER = ['굵게', '+ 글자색·밑줄·취소선', '+ 글자 크기', '+ 배경 강조·가운데 정렬'];
const BENEFIT_ROWS: [string, (g: GradeInfo) => string | string[]][] = [
    ['가격', g => g.plans.length ? g.plans.map(p => `${p.label} ${wonText(p.price)}`) : '무료'],
    ['끌올 보관', g => `${PERKS[g.id].bumpMax}개`],
    ['끌올 충전', g => `${gapText(PERKS[g.id].bumpRefillMinutes)}마다 1개`],
    ['같은 글 끌올 간격', g => gapText(PERKS[g.id].bumpGapMinutes)],
    // 자동 끌올 (WP52): how many posts take turns and how often, from PERKS (copy.md table cells with the
    // owner's intervals): '-', '글 1개 · 4시간마다 1번', '글 5개 중 1개씩 · 1시간 30분마다', '전체 중 1개씩 · 30분마다'.
    ['자동 끌올', g => { const k = PERKS[g.id], every = gapText(k.autoEveryMinutes); return !k.autoBumpPosts ? '-' : k.autoBumpPosts === 1 ? `글 1개 · ${every}마다 1번` : Number.isFinite(k.autoBumpPosts) ? `글 ${k.autoBumpPosts}개 중 1개씩 · ${every}마다` : `전체 중 1개씩 · ${every}마다`; }],
    // 광고 (WP53): where the member's own open posts can show as ads, from PERKS.adSlots.
    ['광고', g => { const n = PERKS[g.id].adSlots; return n ? [`게시판 상단 ${n}개`, '거래완료 글 하단', ...gradeInfo(g.id).rank >= 3 ? ['홈'] : []].join(' · ') : '-'; }],
    ['닉네임 표시', g => NAME_STYLE[g.id] || '-'],
    // 제목 강조 and 링크 미리보기 (WP48): the list title ladder and the save-time link cards.
    ['제목 강조', g => TITLE_STYLE_NAMES[titleTier(g.id)]],
    ['링크 미리보기', g => linkPreviewAllowed(g.id) ? 'O' : '-'],
    // 글자 꾸미기 (WP49): the tools of each grade, shown on the post detail only.
    ['글자 꾸미기', g => STYLE_LADDER[styleRank(g.id)]],
    // 중개·가측 (WP65): free requests per month (shared between the two), handling order, and the
    // 운영진 가측가 on the post for every grade (paid requests too).
    // The 플러스 cells carry the 체험 qualifiers of tier-table.md (no free requests, 4순위 while on the trial).
    ['무료 중개·가측 (매월 1일 초기화)', g => { const n = PERKS[g.id].serviceCoupons; return !n ? '-' : Number.isFinite(n) ? `월 ${n}회${g.id === 'plus' ? ' (체험 중 0)' : ''}` : '무제한'; }],
    ['중개·가측 처리 순서', g => priorityCell(g.id)],
    // 신고 처리 순서 and the manager's unread chats (WP60): the same order by grade, the 체험 as 일반.
    [REPORT_TEXT.order, g => priorityCell(g.id)],
    [REPORT_TEXT.chatOrder, g => priorityCell(g.id)],
    ['운영진 가측가 표시', () => 'O'],
    // 조건 알림 (WP54): saved searches with any filter that send 새 글 알림 (프리미엄 and up also 가격 내림).
    ['조건 알림', g => filterAlertText(PERKS[g.id])],
    // 자동 매칭 (WP58): own posts matched with new posts of the other side, from PERKS.matchPosts and matchChats:
    // '-', '내 글 3개', '내 글 전체 · 채팅 보내기 하루 20번'.
    [MATCH_TEXT.switch, g => matchGuideText(PERKS[g.id])],
    // 자동 가격 내리기 (WP56): '-', '판매 글 1개 · 하루 1번', '5개', '전체', from PERKS.autoPricePosts.
    ['자동 가격 내리기', g => dropGuideText(PERKS[g.id])],
    // 채팅 자동화 (WP57): own quick replies (with {제목} {즉거가} {현젯} from 프리미엄) and the automatic answers.
    ['내 빠른 답장', g => { const k = PERKS[g.id]; return !k.replyTemplates ? '-' : `${k.replyTemplates}개${k.templateVars ? (gradeInfo(g.id).rank >= 3 ? ' · 변수' : ' · ' + TEMPLATE_VARS.join(' ')) : ''}`; }],
    [CHAT_AUTO_TEXT.label, g => { const k = PERKS[g.id]; return [...k.firstReply ? [CHAT_AUTO_TEXT.first] : [], ...k.awayReply ? [CHAT_AUTO_TEXT.away] : []].join(' · ') || '-'; }],
    // 판매 통계 and 대표 글 (WP63): '내 글 줄 수치', '+ 글별 통계 창', '+ 시간대별 조회 · 시세 · 주간 요약'; '-', '1개', '3개', '5개'.
    [STATS_TEXT.title, g => STATS_GUIDE[PERKS[g.id].stats]],
    ['대표 글 고정', g => PERKS[g.id].profilePins ? `${PERKS[g.id].profilePins}개` : '-'],
];
// What the free 일반 grade already has: every cafe basic, with anti-flood ceilings only (SITE_RULES).
const FREE_ITEMS = [
    `사진 글당 ${SITE_RULES.photosPerPost}장`,
    `거래중 글 ${SITE_RULES.openPosts}개`,
    `하루 새 글 ${SITE_RULES.postsPerDay}개`,
    `끌올 ${PERKS.normal.bumpMax}개 · ${gapText(PERKS.normal.bumpRefillMinutes)}마다 충전`,
    // WP58: every grade.
    `모두 끌올 · 일괄 변경 ${BULK_MAX}개`,
    '다시 올리기 · 복사해서 새 글',
    '맞는 구매 글·판매 글 링크',
    '댓글·답글',
    '채팅·제시',
    '기본 빠른 답장',
    '링크 자동 연결',
    '찜·알림',
    `검색 조건 저장 ${SITE_RULES.savedSearches}개`,
    `키워드·게시판 알림 ${SITE_RULES.keywordAlerts}개`,
    '판매자 구독',
    '인기순 정렬',
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
                <li>확인된 거래는 프로필 거래 기록에 남고, 완료된 글에는 거래가가 표시됩니다.</li>
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
                <li>{AD_TEXT.sortNote}</li>
                <li>{AD_TEXT.orderNote}</li>
                <li>{AUTO_TEXT.reserve}</li>
                <li>{AUTO_TEXT.capped}</li>
                <li>{DROP_TEXT.hold}</li>
                <li>하루 새 글 {SITE_RULES.freshPerDay}개까지 새 글로 올라가고, 그 뒤로는 끌올 1개씩 씁니다.</li>
                <li>같은 매물을 다시 올리면 끌올 1개로 칩니다. 끌올 간격 안이면 이전 자리에 올라갑니다.</li>
                <li>같은 매물: 같은 제목, 절반 넘게 같은 사진, 또는 래더·스킨·팬텀 등 매물 정보 3가지 이상이 같은 글입니다.</li>
                <li>중개·가측: 내 판매·교환 계정 글의 더보기에서 가측 신청, 채팅의 더보기에서 중개 신청. 무료 횟수가 없으면 유료이며 수수료는 매니저가 채팅으로 안내합니다. 플러스 체험 중에는 무료 횟수가 없습니다.</li>
                <li>운영진 가측가는 글을 수정하면 표시되지 않습니다.</li>
                <li>{REPORT_TEXT.urgentNote}</li>
                <li>{REPORT_TEXT.demoteNote}</li>
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
