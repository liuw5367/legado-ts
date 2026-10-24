import { BookOpen } from 'lucide-react'
import { BookCover } from './book-cover.tsx'
import type { ApiBook } from '../lib/api.ts'
export function BookListCover({ books }: { books: ApiBook[] }) {
  return <span className="book-list-cover" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => { const book = books[index]; return book ? <BookCover iconFallback key={index} name={book.name} coverUrl={book.coverUrl} /> : <span key={index} className="book-list-cover-empty"><BookOpen aria-hidden="true" /></span> })}</span>
}
