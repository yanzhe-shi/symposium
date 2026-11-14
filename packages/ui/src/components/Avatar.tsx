import { avatarColour, initials } from '../avatar.ts';

interface AvatarProps {
  name: string;
  /** `you` is the human, drawn in the accent colour. `square` is used for groups. */
  variant?: 'agent' | 'you' | 'square';
  size?: 'small' | 'medium';
  /** Shows a pulsing ring while the agent works. */
  working?: boolean;
}

/** A coloured circle with a name's initials. Decorative: the name is always written beside it. */
export function Avatar({ name, variant = 'agent', size = 'medium', working = false }: AvatarProps) {
  const colour = variant === 'you' ? 'avatar-you' : `avatar-${avatarColour(name)}`;
  const classes = ['avatar', colour, `avatar-${size}`];
  if (variant === 'square') classes.push('avatar-square');
  if (working) classes.push('avatar-working');
  return (
    <span className={classes.join(' ')} aria-hidden>
      {initials(name)}
    </span>
  );
}
