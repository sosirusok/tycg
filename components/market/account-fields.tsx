'use client';
import { Checkbox } from '@/components/ui/checkbox';
import { ACCOUNT_CHOICES, FULL_SET, LEGACY_SKELETON, NICK_RANKS, SKIN_OPTIONS, skinTags } from '@/lib/market';

type Fields = Record<string, string>;
type AccountProps = { value: Fields; buying: boolean; wanted?: boolean };
const fieldKey = (key: string, wanted?: boolean) => wanted ? 'wanted' + key[0].toUpperCase() + key.slice(1) : key;
const selectedRanks = (raw?: string): string[] => { try { const parsed: unknown = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && (NICK_RANKS as readonly string[]).includes(v)) : []; } catch { return []; } };

export function SkinChoices({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
    const toggle = (key: string, checked: boolean) => onChange(checked ? [...new Set([...value, key])] : value.filter(v => v !== key));
    const legacy = value.filter(name => !(SKIN_OPTIONS as readonly string[]).includes(name));
    return <><div className="skin-choices">{SKIN_OPTIONS.map(name => <label className="skin-choice" key={name}><Checkbox checked={value.includes(name)} onCheckedChange={v => toggle(name, v === true)}/><span>{name}</span></label>)}</div>{legacy.length > 0 && <div className="legacy-skin-selections" aria-label="기존에 선택한 스킨">{legacy.map(name => <button type="button" key={name} aria-label={name + ' 선택 해제'} onClick={() => onChange(value.filter(v => v !== name && !(name === LEGACY_SKELETON && v === FULL_SET)))}>{name}<span aria-hidden="true">×</span></button>)}</div>}</>;
}

export function AccountFields({ value, onChange, buying, wanted }: AccountProps & { onChange: (v: Fields) => void }) {
    const keyFor = (key: string) => fieldKey(key, wanted);
    const read = (key: string) => value[keyFor(key)] || '';
    const patch = (key: string, v: string) => onChange({ ...value, [keyFor(key)]: v });
    const numberField = (key: string, label: string, min = 0, max = 1000000000, suffix?: string) => <label className="field-label" key={key}>{label}<div className={suffix ? 'money-input' : undefined}><input type="number" min={min} max={max} step="1" inputMode="numeric" placeholder={buying ? '상관없음' : '선택 입력'} value={read(key)} onChange={e => patch(key, e.target.value)}/>{suffix && <span>{suffix}</span>}</div></label>;
    const selectField = (key: string, label: string, options: readonly string[]) => <label className="field-label" key={key}>{label}<select value={read(key)} onChange={e => patch(key, e.target.value)}><option value="">{buying ? '상관없음' : '선택 안 함'}</option>{options.map(v => <option key={v}>{v}</option>)}</select></label>;
    const ranks = selectedRanks(read('nicknameRanks'));
    return <div className="account-fields-v9">
        <div className="detail-fields account-owner-fields">
            {numberField(buying ? 'maxOwners' : 'ownerCount', buying ? '몇 대주 이하까지 구하나요?' : '현재 몇 대주인가요?', 1, 9999, buying ? '대주 이하' : '대주')}
            {selectField(buying ? 'recordPreference' : 'recordStatus', buying ? '전적 조건' : '전적', buying ? ['무전적', '전적 있어도 괜찮음'] : ['무전적', '전적 있음'])}
        </div>
        <div className="subsection-heading"><h4>{buying ? '원하는 닉네임' : '계정 닉네임'}</h4></div>
        {buying ? <><div className="nickname-range-v9"><span>글자 수</span><div>{numberField('nicknameCharsMin', '최소', 1, 20, '글자')}<span className="range-divider" aria-hidden="true">~</span>{numberField('nicknameCharsMax', '최대', 1, 20, '글자')}</div></div><fieldset className="nickname-ranks-v9"><legend>닉 등급 <span>복수 선택 가능</span></legend><div>{NICK_RANKS.map(rank => <label key={rank}><Checkbox checked={ranks.includes(rank)} onCheckedChange={checked => patch('nicknameRanks', JSON.stringify(checked === true ? [...ranks, rank] : ranks.filter(v => v !== rank)))}/><span>{rank}</span></label>)}</div></fieldset></> : <div className="detail-fields">{numberField('nicknameChars', '닉네임 글자 수', 1, 20, '글자')}{selectField('nicknameRank', '닉 등급', NICK_RANKS)}</div>}
        <div className="subsection-heading"><h4>{buying ? '우대 스킨' : '보유 스킨'}</h4><span>복수 선택 가능</span></div><SkinChoices value={skinTags(read('skinTags'))} onChange={v => patch('skinTags', JSON.stringify(v))}/>
        {!buying && <><div className="subsection-heading"><h4>보유 재화</h4></div><div className="detail-fields">{numberField('gas', '가스')}{numberField('minerals', '미네랄')}</div><details className="optional-fields"><summary>추가 계정 정보 <span>선택 입력</span></summary><div className="detail-fields">{['integrated', 'passwordChange', 'phoneChange'].map(key => selectField(key, ACCOUNT_CHOICES[key].label, ACCOUNT_CHOICES[key].options))}{numberField('level', '계정 레벨')}{numberField('humanSkins', '인간 스킨 수')}{numberField('zombieSkins', '좀비 스킨 수')}</div></details></>}
    </div>;
}

export function AccountDetails({ value, buying, wanted }: AccountProps) {
    const read = (key: string) => value[fieldKey(key, wanted)] || '';
    const selected = skinTags(read('skinTags')).filter(v => v !== LEGACY_SKELETON || !skinTags(read('skinTags')).includes(FULL_SET));
    const ranks = selectedRanks(read('nicknameRanks'));
    const number = (key: string, suffix = '') => read(key) ? Number(read(key)).toLocaleString('ko-KR') + suffix : '';
    const nicknameRange = read('nicknameCharsMin') && read('nicknameCharsMax') ? (read('nicknameCharsMin') === read('nicknameCharsMax') ? read('nicknameCharsMin') + '글자' : read('nicknameCharsMin') + ' ~ ' + read('nicknameCharsMax') + '글자') : read('nicknameCharsMin') ? read('nicknameCharsMin') + '글자 이상' : read('nicknameCharsMax') ? read('nicknameCharsMax') + '글자 이하' : '';
    const rows = buying ? [
        ['대주 수 조건', number('maxOwners', '대주 이하')], ['전적 조건', read('recordPreference')], ['원하는 닉 글자 수', nicknameRange], ['원하는 닉 등급', ranks.join(', ')],
    ] : [
        ['대주 수', number('ownerCount', '대주') || read('firstOwner')], ['전적', read('recordStatus')], ['닉네임 글자 수', number('nicknameChars', '글자')], ['닉 등급', read('nicknameRank')], ['가스', number('gas')], ['미네랄', number('minerals')],
    ];
    const extra = buying ? [] : [
        ...['integrated', 'passwordChange', 'phoneChange'].map(key => [ACCOUNT_CHOICES[key].label, read(key)]),
        ['계정 레벨', number('level')], ['인간 스킨 수', number('humanSkins')], ['좀비 스킨 수', number('zombieSkins')],
    ].filter(([, v]) => v);
    const table = (items: string[][]) => <dl className="spec-table">{items.filter(([, v]) => v).map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>;
    return <>{rows.some(([, v]) => v) && table(rows)}{selected.length > 0 && <div className="detail-skins"><h4>{buying ? '우대 스킨' : '보유 스킨'}</h4><div className="skin-badges">{selected.map(v => <span key={v}>{v}</span>)}</div></div>}{extra.length > 0 && <details className="optional-fields"><summary>추가 계정 정보</summary>{table(extra)}</details>}</>;
}
