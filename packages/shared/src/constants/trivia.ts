/**
 * Built-in trivia question bank.
 *
 * Single source of truth shared by the bot (merged with the guild's custom
 * pack when building a round's question pool) and the dashboard (rendered as
 * read-only rows alongside the custom questions so owners can see the full
 * served pool).
 */
import type { TriviaDifficulty } from '../types/database.js';

export interface TriviaQuestionContent {
  question: string;
  correct: string;
  wrong: string[];
  category: string;
  difficulty: TriviaDifficulty;
}

export const BUILT_IN_TRIVIA_QUESTIONS: readonly TriviaQuestionContent[] = [
  { question: 'What planet is known as the Red Planet?', correct: 'Mars', wrong: ['Venus', 'Jupiter', 'Saturn'], category: 'science', difficulty: 'easy' },
  { question: 'What is the chemical symbol for gold?', correct: 'Au', wrong: ['Ag', 'Fe', 'Cu'], category: 'science', difficulty: 'easy' },
  { question: 'In what year did the Titanic sink?', correct: '1912', wrong: ['1905', '1918', '1923'], category: 'history', difficulty: 'medium' },
  { question: 'What is the largest organ in the human body?', correct: 'Skin', wrong: ['Liver', 'Brain', 'Heart'], category: 'science', difficulty: 'easy' },
  { question: 'Which country has the most natural lakes?', correct: 'Canada', wrong: ['USA', 'Russia', 'Brazil'], category: 'geography', difficulty: 'medium' },
  { question: 'What is the speed of light in km/s (approx)?', correct: '300,000', wrong: ['150,000', '500,000', '1,000,000'], category: 'science', difficulty: 'hard' },
  { question: 'Who painted the Mona Lisa?', correct: 'Leonardo da Vinci', wrong: ['Michelangelo', 'Raphael', 'Donatello'], category: 'art', difficulty: 'easy' },
  { question: 'What is the square root of 144?', correct: '12', wrong: ['14', '10', '16'], category: 'math', difficulty: 'easy' },
  { question: 'Which element has the atomic number 1?', correct: 'Hydrogen', wrong: ['Helium', 'Lithium', 'Carbon'], category: 'science', difficulty: 'easy' },
  { question: 'What year was the first iPhone released?', correct: '2007', wrong: ['2005', '2008', '2010'], category: 'technology', difficulty: 'medium' },
  { question: 'What is the capital of Australia?', correct: 'Canberra', wrong: ['Sydney', 'Melbourne', 'Brisbane'], category: 'geography', difficulty: 'medium' },
  { question: 'How many bones are in the adult human body?', correct: '206', wrong: ['198', '212', '220'], category: 'science', difficulty: 'hard' },
  { question: 'What is the longest river in the world?', correct: 'Nile', wrong: ['Amazon', 'Mississippi', 'Yangtze'], category: 'geography', difficulty: 'medium' },
  { question: 'Who wrote "1984"?', correct: 'George Orwell', wrong: ['Aldous Huxley', 'Ray Bradbury', 'H.G. Wells'], category: 'literature', difficulty: 'medium' },
  { question: 'What is the hardest natural substance on Earth?', correct: 'Diamond', wrong: ['Titanium', 'Quartz', 'Sapphire'], category: 'science', difficulty: 'easy' },
  { question: 'In which year did World War II end?', correct: '1945', wrong: ['1944', '1946', '1943'], category: 'history', difficulty: 'easy' },
  { question: 'What is the smallest country in the world?', correct: 'Vatican City', wrong: ['Monaco', 'San Marino', 'Liechtenstein'], category: 'geography', difficulty: 'medium' },
  { question: 'What gas do plants absorb from the atmosphere?', correct: 'Carbon dioxide', wrong: ['Oxygen', 'Nitrogen', 'Hydrogen'], category: 'science', difficulty: 'easy' },
  { question: 'Who developed the theory of relativity?', correct: 'Albert Einstein', wrong: ['Isaac Newton', 'Niels Bohr', 'Max Planck'], category: 'science', difficulty: 'medium' },
  { question: 'What is the deepest ocean trench?', correct: 'Mariana Trench', wrong: ['Tonga Trench', 'Java Trench', 'Puerto Rico Trench'], category: 'geography', difficulty: 'hard' },
];
