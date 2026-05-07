import { useState, useEffect, useCallback } from "react";

const SESSION_KEY = "fere.hasShownFirstDetection";

interface FirstDetectionToastProps {
  serviceName: string;
  port: number;
}

export function useFirstDetection() {
  const [toast, setToast] = useState<FirstDetectionToastProps | null>(null);

  const trigger = useCallback((serviceName: string, port: number) => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, "true");
    } catch {
      return;
    }
    setToast({ serviceName, port });
  }, []);

  const dismiss = useCallback(() => setToast(null), []);

  return { toast, trigger, dismiss };
}

export function FirstDetectionToast({
  serviceName,
  port,
  onDismiss,
}: FirstDetectionToastProps & { onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300); // wait for exit animation
    }, 3000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [onDismiss]);

  return (
    <div className={`first-detection-toast${visible ? " visible" : ""}`}>
      There it is. Fere found <strong>{serviceName}</strong> on port <strong>{port}</strong>.
    </div>
  );
}
