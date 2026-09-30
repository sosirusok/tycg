import { listingPrice, priceText, type Post } from '@/lib/market';

export function PriceDisplay({ post, compact = false }: { post: Post; compact?: boolean }) {
    const sale = post.kind === 'sell';
    const history = sale ? post.price_history || [] : [];
    const currentOffer = post.details.currentOffer;
    const label = sale ? '즉거가' : post.kind === 'buy' ? '최대 예산 (MAX)' : post.kind === 'exchange' ? '교환' : post.kind === 'proxy_request' ? '희망 비용' : '진행 비용';
    return <div className={'market-price' + (compact ? ' compact' : '')}>
        <span className="market-price-label">{label}</span>
        <div className="market-price-line">
            {history.map((entry, index) => <del className="market-price-before" key={index} title={new Date(entry.changed_at).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}>{priceText(entry.price)}</del>)}
            <strong className="market-price-current">{post.kind === 'buy' && post.price !== null ? priceText(post.price) : listingPrice(post)}</strong>
        </div>
        {sale && <span className="market-current-offer">현젯 <b>{currentOffer !== undefined && currentOffer !== '' ? priceText(Number(currentOffer)) : '미기재'}</b></span>}
    </div>;
}
