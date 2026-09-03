import { Button, Result } from "antd";

export function LoadError({ message, onRetry, loading = false }: { message: string; onRetry: () => void; loading?: boolean }) {
  return <div className="load-error" role="alert"><Result status="warning" title="暂时无法加载" subTitle={message} extra={<Button type="primary" onClick={onRetry} loading={loading}>重新加载</Button>} /></div>;
}
