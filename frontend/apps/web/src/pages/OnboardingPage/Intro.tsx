import { useState, useEffect, useRef, useCallback } from 'react';

import { useCurrentUser } from '@/hooks';

function formatDisplayName(name: string | null | undefined): string {
  if (!name?.trim()) {
    return '';
  }

  if (name.includes('@')) {
    return name;
  }

  return name
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

// Survives the welcome step unmounting. A refetch that briefly replaces the
// page with the loader used to mount this again and replay the typing after
// it had already finished. A real browser reload clears this and may play once
// more. A different signed-in person gets their own play.
let introFinishedForUserId: string | null = null;

function introAlreadyFinished(userId: string | undefined): boolean {
  if (introFinishedForUserId == null) {
    return false;
  }

  if (userId == null || introFinishedForUserId === '' || userId === introFinishedForUserId) {
    return true;
  }

  introFinishedForUserId = null;

  return false;
}

interface TypingEffectProps {
  text: string;
  speed?: number;
  onComplete?: () => void;
  className?: string;
  pause?: number;
}

function TypingEffect({
  text,
  speed = 150,
  onComplete = () => {},
  className = '',
  pause = 0,
}: TypingEffectProps) {
  const [displayedText, setDisplayedText] = useState('');

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const completeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (!text) {
      onCompleteRef.current?.();

      return;
    }

    let currentIndex = 0;

    const typeCharacter = () => {
      if (!!completeTimeoutRef.current || currentIndex >= text.length) {
        completeTimeoutRef.current = setTimeout(() => {
          onCompleteRef.current?.();
          completeTimeoutRef.current = undefined;
        }, pause);

        return;
      }

      const char = text[currentIndex];

      setDisplayedText(text.substring(0, currentIndex + 1));
      currentIndex++;

      const jitter = (Math.random() - 0.5) * speed * 0.5;
      let delay = speed + jitter;

      if (',.?!'.includes(char)) {
        delay += speed * 4;
      }

      typingTimeoutRef.current = setTimeout(typeCharacter, delay);
    };

    typeCharacter();

    return () => {
      clearTimeout(typingTimeoutRef.current);
      clearTimeout(completeTimeoutRef.current);
      // A leftover id is truthy, so the next run treated the line as already
      // finished and skipped straight to onComplete.
      typingTimeoutRef.current = undefined;
      completeTimeoutRef.current = undefined;
    };
  }, [text, speed, pause]);

  return <div className={className}>{displayedText}</div>;
}

export function Intro() {
  const { user } = useCurrentUser();
  const userId = user?.id;

  const bodyClassName = 'text-xl sm:text-2xl text-center text-muted-foreground leading-snug';

  const messages = [
    {
      text: `Welcome, ${formatDisplayName(user?.name)}`,
      className:
        'text-[2rem] sm:text-5xl md:text-6xl mb-2 text-center font-semibold tracking-tight leading-[1.1]',
      pause: 350,
    },
    {
      text: "Let's get you started.",
      className: 'text-2xl sm:text-3xl md:text-4xl text-center mb-6 font-medium tracking-tight',
      pause: 400,
    },
    {
      text: "We'll ask you a couple quick questions to help build your initial experience.",
      className: bodyClassName,
      pause: 150,
    },
    {
      text: 'But this is just the beginning.',
      className: bodyClassName,
      pause: 150,
    },
    {
      text: 'Your companion will learn more as you interact.',
      className: bodyClassName,
    },
  ];

  const [completedCount, setCompletedCount] = useState(() =>
    introAlreadyFinished(userId) ? messages.length : 0,
  );

  const handleComplete = useCallback(() => {
    setCompletedCount((count) => {
      const next = count + 1;

      if (next >= messages.length) {
        introFinishedForUserId = userId ?? introFinishedForUserId ?? '';
      }

      return next;
    });
  }, [messages.length, userId]);

  return (
    <div className="w-full max-w-3xl mx-auto space-y-4 text-center px-1">
      {messages.slice(0, completedCount).map((message, index) => (
        <div key={index} className={message.className}>
          {message.text}
        </div>
      ))}

      {completedCount < messages.length && (
        <TypingEffect
          key={completedCount}
          text={messages[completedCount].text}
          className={messages[completedCount].className}
          speed={20}
          pause={messages[completedCount].pause}
          onComplete={handleComplete}
        />
      )}
    </div>
  );
}
