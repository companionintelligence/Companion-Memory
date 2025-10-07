import { useState, useEffect, useRef, useCallback } from 'react';

import { useAuth } from '@/hooks';

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
    };
  }, [text, speed, pause]);

  return <div className={className}>{displayedText}</div>;
}

export function Intro() {
  const [{ user }] = useAuth();

  const messages = [
    {
      text: `Welcome, ${user?.name}`,
      className: 'text-2xl mb-4 text-center',
      pause: 350,
    },
    {
      text: "Let's get you started.",
      className: 'text-lg text-center mb-8',
      pause: 400,
    },
    {
      text: "We'll ask you a couple quick questions to help build your initial experience.",
      pause: 150,
    },
    {
      text: 'But this is just the beginning.',
      pause: 150,
    },
    {
      text: 'Your companion will learn more as you interact.',
    },
  ];

  const [completedCount, setCompletedCount] = useState(0);

  const handleComplete = useCallback(() => {
    setCompletedCount((count) => count + 1);
  }, []);

  return (
    <div className="space-y-3 h-lg md:text-left md:w-sm">
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
