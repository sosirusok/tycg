'use client';
import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search, MessageCircle, PenLine, Users, ChevronRight, ChevronDown, RotateCcw, Shield, ShieldCheck, Crown, Diamond, Medal, BookOpen, ShoppingBag, Tag, LayoutList, UserRound, LogOut, X, Check, Send, SlidersHorizontal, Megaphone, ArrowLeft, LoaderCircle, ChevronsUpDown, LockKeyhole } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Sidebar, SidebarProvider } from '@/components/ui/sidebar';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Pagination, PaginationContent, PaginationItem, PaginationLink } from '@/components/ui/pagination';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { TIERS, validTags, tagName, dateText, priceText, type SeasonTag, type User, type Post } from '@/lib/market';
export async function api(path: string, method = 'GET', data?: unknown): Promise<any> { const r = await fetch('/api/' + path, { method, credentials: 'same-origin', headers: data ? { 'Content-Type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined }); let d: any; try {
    d = await r.json();
}
catch {
    throw new Error('서버에 연결하지 못했습니다. 다시 시도해 주세요.');
} if (!r.ok)
    throw new Error(d.error || '요청에 실패했습니다.'); return d; }
export const errorMessage = (e: unknown) => e instanceof Error ? e.message : '다시 시도해 주세요.';
export function Avatar({ name, size = '' }: {
    name: string;
    size?: string;
}) { return <span className={'avatar ' + size}>{name.slice(0, 1)}</span>; }
export function Role({ role }: {
    role: string;
}) { return <span className={'role ' + (role === 'manager' ? 'manager' : '')}>{role === 'manager' ? <><Crown size={12}/> 매니저</> : '일반 회원'}</span>; }
export function Loading() { return <div className="loading-block" aria-label="불러오는 중"><Skeleton className="h-8 w-1/2"/><Skeleton className="h-16 w-full"/><Skeleton className="h-16 w-full"/></div>; }
export function EmptyState({ title, description, children }: {
    title: string;
    description: string;
    children?: React.ReactNode;
}) { return <Empty className="empty-state"><EmptyHeader><EmptyMedia><BookOpen size={30}/></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader>{children}</Empty>; }
export function TagBadges({ tags, limit = 99 }: {
    tags: SeasonTag[];
    limit?: number;
}) { return <div className="tag-badges">{tags.slice(0, limit).map(t => <span key={t.tier + t.season} style={{ '--tier-color': TIERS.find(v => v.id === t.tier)?.color } as React.CSSProperties}>{tagName(t)}</span>)}{tags.length > limit && <span>+{tags.length - limit}</span>}</div>; }
export function SeasonPicker({ value, onChange, search = false }: {
    value: SeasonTag[];
    onChange: (v: SeasonTag[]) => void;
    search?: boolean;
}) {
    const [tier, setTier] = useState(value[0]?.tier || 'master');
    const current = TIERS.find(t => t.id === tier)!;
    const toggle = (season: number) => onChange(value.some(t => t.tier === tier && t.season === season) ? value.filter(t => !(t.tier === tier && t.season === season)) : [...value, { tier, season }]);
    return <div className="season-picker"><Tabs value={tier} onValueChange={setTier}><TabsList className="tier-tabs">{TIERS.map((t, i) => <TabsTrigger value={t.id} key={t.id} className="tier-tab" style={{ '--tier-color': t.color } as React.CSSProperties}>{i > 6 ? <Crown /> : i === 5 ? <Diamond /> : i === 6 ? <Medal /> : <Shield />}<span>{t.name}</span>{value.filter(v => v.tier === t.id).length > 0 && <b>{value.filter(v => v.tier === t.id).length}</b>}</TabsTrigger>)}</TabsList>{TIERS.map(t => <TabsContent key={t.id} value={t.id} className="season-panel"><div className="season-panel-heading"><strong>{t.name} <span>{t.min}~32시즌</span></strong><button type="button" className="subtle" onClick={() => { const hasAll = Array.from({ length: 33 - t.min }, (_, i) => i + t.min).every(n => value.some(v => v.tier === tier && v.season === n)); onChange(hasAll ? value.filter(v => v.tier !== tier) : [...value.filter(v => v.tier !== tier), ...Array.from({ length: 33 - t.min }, (_, i) => ({ tier, season: i + t.min }))]); }}>{value.filter(v => v.tier === tier).length === 33 - t.min ? '선택 해제' : '이 티어 전체 선택'}</button></div><div className="seasons">{Array.from({ length: 33 - t.min }, (_, i) => i + t.min).map(n => { const checked = value.some(v => v.tier === tier && v.season === n); return <label key={n} className={checked ? 'season checked' : 'season'}><Checkbox checked={checked} onCheckedChange={() => toggle(n)} aria-label={`${t.name} ${n}시즌`}/><span>{n}시즌</span></label>; })}</div></TabsContent>)}</Tabs><div className="selection-footer"><span>{value.length ? <><b>{value.length}개</b> {search ? '검색 조건 선택' : '시즌 선택'}</> : '티어를 누른 뒤 시즌을 선택해 주세요.'}</span><button className="subtle" type="button" onClick={() => onChange([])} disabled={!value.length}><RotateCcw size={13}/> 초기화</button></div>{value.length > 0 && <div className="selected-tags">{value.map(t => <button type="button" key={t.tier + t.season} aria-label={tagName(t) + ' 선택 해제'} onClick={() => onChange(value.filter(v => v.tier !== t.tier || v.season !== t.season))}>{tagName(t)}<X size={12}/></button>)}</div>}</div>;
}
export function AuthDialog({ mode, setMode, onSuccess }: {
    mode: string;
    setMode: (v: string) => void;
    onSuccess: (u: User) => void;
}) {
    const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [nickname, setNickname] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { setError(''); setPassword(''); }, [mode]);
    async function submit(e: FormEvent) { e.preventDefault(); if (busy)
        return; setBusy(true); setError(''); try {
        const d = await api('auth/' + mode, 'POST', { username, password, nickname });
        onSuccess(d.user);
        setMode('');
        setPassword('');
        toast.success(mode === 'register' ? '가입이 완료되었습니다.' : '로그인되었습니다.');
    }
    catch (e) {
        setError(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    return <Dialog open={!!mode} onOpenChange={open => { if (!open && !busy)
        setMode(''); }}><DialogContent className="auth-dialog"><DialogTitle>{mode === 'register' ? '좀비고 거래소 가입' : '로그인'}</DialogTitle><DialogDescription>{mode === 'register' ? '아이디와 닉네임으로 회원가입하세요.' : '로그인하고 거래와 대화를 이어가세요.'}</DialogDescription><form onSubmit={submit} className="form-stack"><label>아이디<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="영문, 숫자, 밑줄 4~24자" minLength={4} maxLength={24} required/></label>{mode === 'register' && <label>닉네임<input autoComplete="nickname" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="2~16자" minLength={2} maxLength={16} required/></label>}<label>비밀번호<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="8자 이상" minLength={8} maxLength={128} required/></label>{error && <p role="alert" className="error-text">{error}</p>}<button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18}/> : mode === 'register' ? '회원가입' : '로그인'}</button></form><p className="auth-switch">{mode === 'register' ? '이미 계정이 있으신가요?' : '아직 회원이 아니신가요?'} <button onClick={() => setMode(mode === 'register' ? 'login' : 'register')} disabled={busy}>{mode === 'register' ? '로그인' : '회원가입'}</button></p></DialogContent></Dialog>;
}
import { createContext, useContext } from 'react';
export type MarketContext = {
    me: User | null;
    ready: boolean;
    go: (p: string) => void;
    login: (next?: string | (()=>void)) => void;
    refresh: () => void;
    setMe: (u: User) => void;
    chat: (u: string, p?: number) => void;
    revision: number;
    setBeforeLeave: (guard: (() => Promise<boolean>) | null) => void;
};
export const MarketApp = createContext<MarketContext>(null!);
export const useMarket = () => useContext(MarketApp);
export function LoginGate() { const { ready, login } = useMarket(); return !ready ? <Loading /> : <EmptyState title="로그인이 필요합니다" description="회원가입 후 거래 글과 대화를 관리할 수 있습니다."><button className="primary" onClick={() => login()}>로그인 / 회원가입</button></EmptyState>; }
export function PolicyNote() { return <p className="policy-note">계정 거래, 공유 및 대리 플레이는 게임 운영정책에 따라 제재될 수 있습니다. <a href="https://awesomepiece.com/management.html" target="_blank" rel="noreferrer">운영정책 확인 ↗</a></p>; }
