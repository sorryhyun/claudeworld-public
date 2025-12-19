import { useState, useRef, useEffect, memo } from 'react';
import { cn } from '@/lib/utils';

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  placeholderColor?: string;
  /** Fallback element to show when image fails to load */
  fallback?: React.ReactNode;
  /** Root margin for IntersectionObserver (e.g., "100px" to load earlier) */
  rootMargin?: string;
  /** Additional props to pass to the img element */
  imgProps?: React.ImgHTMLAttributes<HTMLImageElement>;
}

/**
 * LazyImage component that uses IntersectionObserver for efficient lazy loading.
 * Shows a placeholder color while loading and handles load errors gracefully.
 */
export const LazyImage = memo(function LazyImage({
  src,
  alt,
  className,
  placeholderColor = 'bg-slate-200',
  fallback,
  rootMargin = '50px',
  imgProps,
}: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Check if IntersectionObserver is supported
    if (!('IntersectionObserver' in window)) {
      // Fallback: load immediately
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.unobserve(entry.target);
          }
        });
      },
      {
        rootMargin,
        threshold: 0,
      }
    );

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [rootMargin]);

  const handleLoad = () => {
    setIsLoaded(true);
    setHasError(false);
  };

  const handleError = () => {
    setHasError(true);
    setIsLoaded(true);
  };

  // If there's an error and a fallback is provided, show the fallback
  if (hasError && fallback) {
    return <>{fallback}</>;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative overflow-hidden',
        !isLoaded && placeholderColor,
        className
      )}
    >
      {/* Placeholder shimmer effect while loading */}
      {!isLoaded && (
        <div className="absolute inset-0 animate-shimmer" />
      )}

      {/* Actual image - only render src when in view */}
      {isInView && (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          onLoad={handleLoad}
          onError={handleError}
          className={cn(
            'w-full h-full object-cover transition-opacity duration-300',
            isLoaded ? 'opacity-100' : 'opacity-0'
          )}
          {...imgProps}
        />
      )}
    </div>
  );
});
