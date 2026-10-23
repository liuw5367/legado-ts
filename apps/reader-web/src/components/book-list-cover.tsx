import { BookCover } from './book-cover.tsx'
import type { ApiBook } from '../lib/api.ts'
export function BookListCover({ books }: { books: ApiBook[] }) {
  return <span className="book-list-cover" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => { const book = books[index]; return book ? <BookCover key={index} name={book.name} coverUrl={book.coverUrl} /> : <span key={index} className="book-list-cover-empty">书</span> })}</span>
}
