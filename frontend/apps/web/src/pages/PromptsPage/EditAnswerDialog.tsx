import { useState, useRef, useEffect, type FormEvent } from 'react';

import { Button, Dialog, IconButton, Textarea, Spinner } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

interface Answer {
  id: string;
  ragAnswer: string;
  answer: string;
  user?: { id: string };
  question?: {
    id: string;
    text: string;
  };
}

interface Props {
  open?: boolean;
  answer: Answer | null;
  onClose?: () => void;
  onSave?: (answerId: string, answerText: string) => Promise<void>;
}

export function EditAnswerDialog({ open, answer, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charCount, setCharCount] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  // Initialize character count when answer changes
  useEffect(() => {
    if (answer) {
      setCharCount((answer.answer || '').length);
      setError(null);
    }
  }, [answer]);

  const handleClose = () => {
    if (loading) {
      return;
    }

    formRef.current?.reset();
    setCharCount(0);
    setError(null);
    onClose?.();
  };

  const handleSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!answer || !onSave) {
      return;
    }

    const formData = new FormData(e.currentTarget);
    const answerText = (formData.get('answer') as string) || '';
    const trimmedText = answerText.trim();

    if (!trimmedText) {
      setError('Answer text is required');

      return;
    }

    if (trimmedText.length > 5000) {
      setError('Answer text must be 5000 characters or less');

      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onSave(answer.id, trimmedText);
      handleClose();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update answer';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  if (!answer) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <Dialog.Content className="p-0 flex flex-col gap-0" showCloseButton={false}>
        <Dialog.Header className="flex flex-row items-center justify-between border-b bg-stone-50 dark:bg-secondary rounded-t-lg gap-2 p-2 pl-4">
          <Dialog.Title>Edit Answer</Dialog.Title>
          <Dialog.Description className="hidden">Edit the answer text.</Dialog.Description>

          <div className="flex items-center justify-end">
            <IconButton variant="ghost" onClick={handleClose} disabled={loading} label={t('COMMON_CLOSE')}>
              <X />
            </IconButton>
          </div>
        </Dialog.Header>

        <form ref={formRef} onSubmit={handleSave} className="flex flex-col gap-4 p-4" key={answer.id}>
          {answer.question && (
            <div>
              <label className="text-sm font-medium text-muted-foreground mb-1 block">Question</label>
              <div className="text-sm text-foreground p-2 bg-muted rounded-md">{answer.question.text}</div>
            </div>
          )}

          <div>
            <label htmlFor="answer-text" className="text-sm font-medium text-muted-foreground mb-1 block">
              Answer
            </label>
            <Textarea
              id="answer-text"
              name="answer"
              defaultValue={answer.answer || ''}
              onInput={(e) => {
                setCharCount(e.currentTarget.value.length);
                setError(null);
              }}
              disabled={loading}
              className={`min-h-32 transition-all ${
                error
                  ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
                  : ''
              }`}
              placeholder="Enter your answer..."
              maxLength={5000}
            />
            <div className="flex items-center justify-between mt-1">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <p
                className={`text-xs ml-auto ${charCount > 5000 ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {charCount}/5000
              </p>
            </div>
          </div>

          <Dialog.Footer>
            <Button type="button" variant="secondary" onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? <Spinner variant="circle" /> : null}
              Save
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
