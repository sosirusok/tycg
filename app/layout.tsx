import type { Metadata } from 'next';
import './globals.css';
import './marketplace.css';
import './market-foundation-v7.css';
import './market-board-v7.css';
import './market-editor-v9.css';
import './market-price.css';
export const metadata: Metadata = { title: '좀비고 거래소 | 구매, 판매, 교환, 대리', description: '좀비고 계정과 클랜 구매, 판매, 교환부터 대리까지. 원하는 거래 조건으로 검색하고 채팅으로 문의하세요.', icons: { icon: '/favicon.svg' } };
export default function RootLayout({ children }: {
    children: React.ReactNode;
}) { return <html lang="ko"><body>{children}</body></html>; }
