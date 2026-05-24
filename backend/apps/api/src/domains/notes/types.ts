export interface CreateNoteDto {
  id?: string;
  title?: string | null;
  content?: string | null;
}

export interface UpdateNoteDto {
  title?: string | null;
  content?: string | null;
}
