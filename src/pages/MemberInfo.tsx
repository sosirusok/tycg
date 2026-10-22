import { useState } from 'react';
import { type InfoField } from '../../shared/membership';
import { ApiError } from '../lib/api';
import { useApp } from '../app/state';
import { EmptyState, SkeletonRows } from '../components/ui';
import { InfoList } from '../components/InfoList';

// /member-info: 회원 정보 for a 관리자-grade member the manager allowed (manage 회원 정보 '관리자 열람 권한'), with only
// the allowed columns. The Worker (GET member-info) decides: it answers 403 for anyone else, also once the grant is
// removed or the 관리자 grade ends, and sends no other field.
export default function MemberInfoPage() {
    const { me, ready, infoFields } = useApp();
    const [fields, setFields] = useState<InfoField[] | null>(null), [denied, setDenied] = useState(false);
    if (!ready) return <div className="container page"><SkeletonRows /></div>;
    if (!me || denied) return <div className="container page"><EmptyState icon="lock" title="회원 정보를 볼 권한이 없습니다" /></div>;
    return <div className="container page">
        <h1 className="page-title">회원 정보</h1>
        <p className="muted small mt-8">매니저가 지정한 항목만 보입니다. 다른 곳에 옮기거나 알리지 마세요.</p>
        <div className="panel panel-body mt-16">
            <InfoList endpoint="member-info" fields={fields ?? infoFields} onPage={d => setFields(d.fields)}
                onError={e => { if (e instanceof ApiError && e.status === 403) { setDenied(true); return true; } return false; }} />
        </div>
    </div>;
}
