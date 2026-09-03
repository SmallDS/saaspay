import type { CSSProperties, ReactNode } from "react";

export function SkeletonBar({ width, height, className = "" }: { width?: CSSProperties["width"]; height?: CSSProperties["height"]; className?: string }) {
  return <span aria-hidden="true" className={`skeleton-bar ${className}`} style={{ width, height }} />;
}

function LoadingRegion({ children, label, className = "" }: { children: ReactNode; label: string; className?: string }) {
  return <div className={`loading-region ${className}`} aria-busy="true"><span className="sr-only" role="status">{label}</span>{children}</div>;
}

export function HeaderSkeleton() {
  return <header className="site-header" aria-hidden="true"><SkeletonBar width={140} height={24} /><div className="skeleton-nav"><SkeletonBar width={52} /><SkeletonBar width={68} /></div></header>;
}

export function FooterSkeleton() {
  return <footer className="site-footer" aria-hidden="true"><SkeletonBar width={150} /><SkeletonBar width={180} /></footer>;
}

export function StorefrontSkeleton({ title = "" }: { title?: string }) {
  return <div className="public-site"><HeaderSkeleton /><LoadingRegion label="正在加载商品页面">
    <section className="block hero-block"><div className="container hero-inner"><div className="hero-copy">
      <SkeletonBar width={104} height={30} className="skeleton-eyebrow" />
      {title ? <h1>{title}</h1> : <SkeletonBar width="80%" height={78} className="skeleton-title" />}
      <SkeletonBar width="62%" height={22} className="skeleton-description" />
      <SkeletonBar width={128} height={40} className="skeleton-button" />
    </div></div></section>
    <section className="block"><div className="container"><SkeletonBar width="32%" height={38} /><div className="skeleton-content-grid">{[0, 1, 2].map((key) => <div className="skeleton-content-card" key={key}><SkeletonBar width="55%" height={24} /><SkeletonBar /><SkeletonBar width="78%" /></div>)}</div></div></section>
  </LoadingRegion><FooterSkeleton /></div>;
}

export function CheckoutSkeleton() {
  return <main className="checkout-shell"><div className="container checkout-layout"><LoadingRegion className="checkout-card skeleton-checkout-card" label="正在加载套餐和支付方式">
    <div className="checkout-heading"><div className="eyebrow">Checkout</div><h1>填写购买信息</h1><p>请留下联系方式，支付完成后我们会据此联系你。</p></div>
    <div className="checkout-summary"><div className="skeleton-summary-copy"><SkeletonBar width="45%" /><SkeletonBar width="70%" height={26} /><SkeletonBar /></div><div className="checkout-price"><SkeletonBar width={100} height={36} /><SkeletonBar width={70} /></div></div>
    {[0, 1, 2].map((key) => <div className="skeleton-field" key={key}><SkeletonBar width={72} /><SkeletonBar height={key === 2 ? 24 : 34} width={key === 2 ? "55%" : "100%"} /></div>)}
    <div className="checkout-actions"><SkeletonBar height={40} /><SkeletonBar height={40} /></div>
  </LoadingRegion></div></main>;
}

export function ResultSkeleton() {
  return <LoadingRegion className="skeleton-result" label="正在查询支付结果"><SkeletonBar width={72} height={72} className="skeleton-circle" /><SkeletonBar width={220} height={30} /><SkeletonBar width="70%" /><div className="skeleton-nav"><SkeletonBar width={100} height={32} /><SkeletonBar width={80} height={32} /></div></LoadingRegion>;
}

export function DashboardSkeleton() {
  return <LoadingRegion label="正在加载仪表盘"><div className="skeleton-stats-grid">{[0, 1, 2, 3].map((key) => <div className="skeleton-content-card" key={key}><SkeletonBar width={80} /><SkeletonBar width="65%" height={38} /></div>)}</div><div className="skeleton-content-card skeleton-table"><SkeletonBar width={100} height={22} />{[0, 1, 2, 3, 4].map((key) => <div className="skeleton-table-row" key={key}>{[0, 1, 2, 3].map((cell) => <SkeletonBar key={cell} width={cell ? "70%" : "85%"} />)}</div>)}</div></LoadingRegion>;
}

export function AuthSkeleton() {
  return <div className="login-shell"><LoadingRegion className="login-card skeleton-content-card" label="正在验证登录状态"><SkeletonBar width="60%" height={30} /><SkeletonBar /><SkeletonBar height={36} /><SkeletonBar height={36} /><SkeletonBar height={40} /></LoadingRegion></div>;
}
