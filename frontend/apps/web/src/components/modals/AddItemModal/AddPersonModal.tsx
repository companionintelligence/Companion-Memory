import { useState, type FormEvent } from 'react';

import { useMutation } from '@apollo/client';
import { Button, Dialog, Input, Textarea, Label } from '@ci/shadcn';

import { gql } from '@/graphql';

const CREATE_PERSON = gql(`
  mutation CreatePerson($input: CreatePersonInput!) {
    createPerson(input: $input) {
      success
      person {
        id
        name
        description
      }
    }
  }
`);

interface Props {
  open?: boolean;
  onClose?: (open?: boolean) => void;
}

export function AddPersonModal({ open, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState('');

  const [createPerson, { loading }] = useMutation(CREATE_PERSON);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Validate name
    if (!name.trim()) {
      setNameError('Enter a name');

      return;
    }

    // Clear error if validation passes
    setNameError('');

    try {
      await createPerson({
        variables: {
          input: {
            name: name.trim(),
            description: description.trim(),
          },
        },
      });

      // Reset form and close modal on success
      setName('');
      setDescription('');
      onClose?.(false);
    } catch (error) {
      console.error('Failed to create person:', error);
    }
  };

  const handleCancel = () => {
    setName('');
    setDescription('');
    setNameError('');
    onClose?.(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <Dialog.Content className="sm:max-w-md">
        <Dialog.Header>
          <Dialog.Title>Add Person</Dialog.Title>
        </Dialog.Header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) {
                  setNameError('');
                }
              }}
              placeholder="Enter name"
            />
            {nameError && <p className="text-sm text-destructive">{nameError}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter description"
            />
          </div>

          <Dialog.Footer className="flex gap-2 justify-end">
            <Button type="button" variant="destructive" onClick={handleCancel} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" className="bg-green-600 hover:bg-green-700" disabled={loading}>
              Add
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
