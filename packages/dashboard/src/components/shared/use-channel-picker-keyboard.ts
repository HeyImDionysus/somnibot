import { useCallback, useEffect, useRef } from 'react';
import type {
  FocusEventHandler,
  KeyboardEventHandler,
  RefObject,
} from 'react';

type OpeningFocus = 'search' | 'first' | 'last';

interface ChannelPickerKeyboardOptions {
  readonly listboxRef: RefObject<HTMLDivElement | null>;
  readonly open: boolean;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly setOpen: (open: boolean) => void;
  readonly setSearch: (search: string) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

interface ChannelPickerKeyboard {
  readonly closePicker: (restoreFocus: boolean) => void;
  readonly onBlurCapture: FocusEventHandler<HTMLDivElement>;
  readonly onOptionKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  readonly onSearchKeyDown: KeyboardEventHandler<HTMLInputElement>;
  readonly onTriggerKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  readonly openPicker: (focus: OpeningFocus) => void;
}

export function useChannelPickerKeyboard({
  listboxRef,
  open,
  searchRef,
  setOpen,
  setSearch,
  triggerRef,
}: ChannelPickerKeyboardOptions): ChannelPickerKeyboard {
  const openingFocusRef = useRef<OpeningFocus>('search');

  const enabledOptions = useCallback((): readonly HTMLButtonElement[] => {
    if (!listboxRef.current) return [];
    return Array.from(
      listboxRef.current.querySelectorAll<HTMLButtonElement>('[data-channel-option]:not(:disabled)'),
    );
  }, [listboxRef]);

  const focusBoundaryOption = useCallback((position: 'first' | 'last') => {
    const options = enabledOptions();
    const option = position === 'first' ? options[0] : options.at(-1);
    option?.focus();
  }, [enabledOptions]);

  const openPicker = useCallback((focus: OpeningFocus) => {
    openingFocusRef.current = focus;
    setOpen(true);
  }, [setOpen]);

  const closePicker = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setSearch('');
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [setOpen, setSearch, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target = openingFocusRef.current;
      if (target === 'search') searchRef.current?.focus();
      else focusBoundaryOption(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusBoundaryOption, open, searchRef]);

  const onTriggerKeyDown = useCallback<KeyboardEventHandler<HTMLButtonElement>>((event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openPicker(event.key === 'ArrowDown' ? 'first' : 'last');
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closePicker(true);
    }
  }, [closePicker, open, openPicker]);

  const onSearchKeyDown = useCallback<KeyboardEventHandler<HTMLInputElement>>((event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusBoundaryOption(event.key === 'ArrowDown' ? 'first' : 'last');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePicker(true);
    }
  }, [closePicker, focusBoundaryOption]);

  const onOptionKeyDown = useCallback<KeyboardEventHandler<HTMLButtonElement>>((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker(true);
      return;
    }
    const options = enabledOptions();
    const currentIndex = options.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusBoundaryOption(event.key === 'Home' ? 'first' : 'last');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + offset + options.length) % options.length;
      options[nextIndex]?.focus();
    }
  }, [closePicker, enabledOptions, focusBoundaryOption]);

  const onBlurCapture = useCallback<FocusEventHandler<HTMLDivElement>>((event) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (open) closePicker(false);
  }, [closePicker, open]);

  return {
    closePicker,
    onBlurCapture,
    onOptionKeyDown,
    onSearchKeyDown,
    onTriggerKeyDown,
    openPicker,
  };
}
