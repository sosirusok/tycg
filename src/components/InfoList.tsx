import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { INFO_LABELS, phoneText, type InfoField, type MemberInfo } from '../../shared/membership';
import { api, errorText } from '../lib/api';
import { EmptyState, SkeletonRows } from './ui';

export type InfoRow = MemberInfo & { id: string; nickname: string; role: string };
export type InfoPage = { members: InfoRow[]; more: boolean; page: number; fields?: InfoField[] };

// One field as shown: 휴대전화번호 as 010-1234-5678; none: '없음'.
export const infoValue = (field: InfoField, v: string | null | undefined) => v ? field === 'phone' ? phoneText(v) : v : '없음';

// 회원 정보 (manage/info for the manager, member-info for a 관리자 the manager allowed): the members with the given
// columns, a nickname search and '더 보기' (50 a page). `onPage` gets each first page's answer (the manager's
// 관리자 열람 권한 list rides on it); `onError` takes a failed first page (member-info answers 403).
export function InfoList({ endpoint, fields, onPage, onError, children }: { endpoint: string; fields: readonly InfoField[]; onPage?: (d: any) => void; onError?: (e: unknown) => boolean; children?: ReactNode }) {
    const [q, setQ] = useState(''), [applied, setApplied] = useState(''), [rows, setRows] = useState<InfoRow[] | null>(null), [more, setMore] = useState(false), [page, setPage] = useState(1), [busy, setBusy] = useState(false);
    const hooks = useRef({ onPage, onError });
    hooks.current = { onPage, onError };
    const load = useCallback((n: number) => api<InfoPage>(`${endpoint}?${new URLSearchParams({ q: applied, page: String(n) })}`), [endpoint, applied]);
    useEffect(() => {
        let alive = true;
        setRows(null);
        load(1).then(d => { if (!alive) return; setRows(d.members); setMore(d.more); setPage(1); hooks.current.onPage?.(d); })
            .catch(e => { if (!alive) return; setRows([]); if (!hooks.current.onError?.(e)) toast.error(errorText(e)); });
        return () => { alive = false; };
    }, [load]);
    async function next() {
        if (busy || !rows) return;
        setBusy(true);
        try { const d = await load(page + 1), seen = new Set(rows.map(r => r.id)); setRows([...rows, ...d.members.filter(r => !seen.has(r.id))]); setMore(d.more); setPage(page + 1); }
        catch (e) { toast.error(errorText(e)); }
        finally { setBusy(false); }
    }
    const submit = (e: FormEvent) => { e.preventDefault(); setApplied(q.trim()); };
    return <>
        <form className="search-input" onSubmit={submit} role="search"><Search size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="닉네임" aria-label="닉네임 검색" maxLength={30} /></form>
        {children}
        <div className="mt-16">{rows === null ? <SkeletonRows count={4} height={48} /> : rows.length ? <>
            <div className="table-scroll"><table className="info-table">
                <thead><tr><th scope="col">닉네임</th>{fields.map(f => <th key={f} scope="col">{INFO_LABELS[f]}</th>)}</tr></thead>
                <tbody>{rows.map(r => <tr key={r.id}><th scope="row">{r.nickname}</th>{fields.map(f => <td key={f} className={r[f] ? undefined : 'muted'}>{infoValue(f, r[f])}</td>)}</tr>)}</tbody>
            </table></div>
            {more && <button type="button" className="btn btn-line more-btn" disabled={busy} onClick={() => void next()}>더 보기</button>}
        </> : <EmptyState icon="search" title="회원이 없습니다" />}</div>
    </>;
}
