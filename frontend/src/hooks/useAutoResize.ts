import { useEffect, useRef, useCallback } from "react";

/**
 * Hook for auto-resizing textarea elements based on content.
 *
 * @param value - The current value of the textarea
 * @param minHeight - Minimum height in pixels (default: 40)
 * @param maxHeight - Maximum height in pixels (default: 200)
 * @returns ref to attach to the textarea element
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const [value, setValue] = useState('');
 *   const textareaRef = useAutoResize(value, 44, 150);
 *
 *   return (
 *     <textarea
 *       ref={textareaRef}
 *       value={value}
 *       onChange={(e) => setValue(e.target.value)}
 *     />
 *   );
 * }
 * ```
 */
export function useAutoResize(value: string, minHeight = 40, maxHeight = 200) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto";

    // Calculate new height within bounds
    const newHeight = Math.min(
      Math.max(textarea.scrollHeight, minHeight),
      maxHeight,
    );

    textarea.style.height = `${newHeight}px`;
  }, [value, minHeight, maxHeight]);

  // Reset function for use after submit
  const reset = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
    }
  }, []);

  return { ref: textareaRef, reset };
}
