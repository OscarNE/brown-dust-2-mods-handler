// app/src/constants/canon.ts

export const CHARACTERS = [
  { id: 1, slug: "anna", display_name: "Anna" },
  { id: 2, slug: "erza", display_name: "Erza" },
  { id: 3, slug: "hana", display_name: "Hana" },
  { id: 4, slug: "luna", display_name: "Luna" },
  // add more as you go — later the crawler will update this dynamically
];

export const COSTUMES = [
  // Each costume links to a character_id
  { id: 1, character_id: 2, slug: "armored", display_name: "Armored" },
  { id: 2, character_id: 2, slug: "casual", display_name: "Casual" },
  { id: 3, character_id: 3, slug: "summer", display_name: "Summer Outfit" },
  { id: 4, character_id: 4, slug: "maid", display_name: "Maid Uniform" },
];
