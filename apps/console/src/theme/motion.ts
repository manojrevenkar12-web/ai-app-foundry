/** One orchestrated reveal per page, and motion that answers what a person does. */
export const EASE = [0.2, 0.9, 0.25, 1] as const;
export const DURATION = { quick: 0.15, base: 0.26, slow: 0.6, wire: 0.9 } as const;
export const STAGGER = 0.04;

export const reveal = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE } },
};
export const list = { hidden: {}, shown: { transition: { staggerChildren: STAGGER } } };
