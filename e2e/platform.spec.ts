import { test, expect } from '@playwright/test';
import { addObject, enablePlayer, playerState, play } from './helpers';

test('player moves, jumps, and play mode restores the scene', async ({ page }) => {
  await page.goto('/');
  await enablePlayer(page);
  await addObject(page, 'Ground');
  const before = await playerState(page);
  await play(page);
  await page.waitForTimeout(500);
  const grounded = await playerState(page);
  expect(grounded.grounded).toBe(true);
  await page.keyboard.down('d');
  await page.waitForTimeout(350);
  await page.keyboard.up('d');
  const moved = await playerState(page);
  expect(moved.position[0] - grounded.position[0]).toBeGreaterThan(0.5);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  const jumped = await playerState(page);
  expect(jumped.position[1] - grounded.position[1]).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect((await playerState(page)).position).toEqual(before.position);
});

test('player can land and jump from an elevated platform', async ({ page }) => {
  await page.goto('/');
  await enablePlayer(page);
  await addObject(page, 'Box');
  await page.getByRole('button', { name: 'Select', exact: true }).last().click();
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  const fields = page.getByRole('region', { name: 'Transform' }).getByRole('spinbutton');
  await fields.nth(1).fill('1');
  await fields.nth(6).fill('3');
  await fields.nth(7).fill('0.5');
  await fields.nth(8).fill('3');
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await page.getByRole('region', { name: 'Physics' }).getByRole('checkbox').first().check();
  await page.getByRole('region', { name: 'Physics' }).getByRole('checkbox').nth(2).check();
  await play(page);
  await page.evaluate(async () => {
    const modulePath = '/src/store/editorStore.ts';
    const { useEditorStore } = await import(/* @vite-ignore */ modulePath);
    const player = useEditorStore.getState().sceneObjects[0];
    player.object.position.set(0, 3, 0);
    player.properties.physics.velocity = [0, 0, 0];
  });

  await page.waitForTimeout(1800);
  const landed = await playerState(page);
  expect(landed.position[1]).toBeGreaterThan(1.5);
  expect(landed.grounded).toBe(true);
  await page.keyboard.down('Space');
  await page.waitForTimeout(250);
  await page.keyboard.up('Space');
  expect((await playerState(page)).position[1]).toBeGreaterThan(landed.position[1] + 0.2);
});

test('space jumps without activating the focused play button', async ({ page }) => {
  await page.goto('/');
  await enablePlayer(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(500);
  const before = await playerState(page);
  await page.keyboard.down('Space');
  await page.waitForTimeout(200);
  await page.keyboard.up('Space');
  const after = await playerState(page);
  expect(after.playing).toBe(true);
  expect(after.position[1]).toBeGreaterThan(before.position[1] + 0.2);
});

test('platform sides and undersides stop the player without grounding it', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js';
    const physicsPath = '/src/systems/PhysicsEngine.ts';
    const THREE = await import(/* @vite-ignore */ threePath);
    const { advancePhysics } = await import(/* @vite-ignore */ physicsPath);
    const make = (id: string, position: number[], scale: number[], velocity: number[], isKinematic: boolean) => {
      const object = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
      object.position.fromArray(position);
      object.scale.fromArray(scale);
      return {
        id, object,
        properties: {
          position, scale,
          physics: { enabled: true, isKinematic, velocity, acceleration: [0, 0, 0], useGravity: false },
          characterController: isKinematic ? undefined : { isGrounded: false },
        },
      };
    };
    const platform = make('platform', [0, 2, 0], [3, 0.5, 3], [0, 0, 0], true);
    const side = make('side', [2.2, 2, 0], [1, 1, 1], [-4, 0, 0], false);
    advancePhysics([side, platform], 0.2, -9.8, THREE);
    const underside = make('underside', [0, 0.5, 0], [1, 1, 1], [0, 10, 0], false);
    advancePhysics([underside, platform], 0.15, -9.8, THREE);
    return {
      sideX: side.object.position.x,
      sideVelocity: side.properties.physics.velocity[0],
      sideGrounded: side.properties.characterController?.isGrounded,
      undersideY: underside.object.position.y,
      undersideVelocity: underside.properties.physics.velocity[1],
      undersideGrounded: underside.properties.characterController?.isGrounded,
      platformY: platform.object.position.y,
    };
  });
  expect(result.sideX).toBeCloseTo(2);
  expect(result.sideVelocity).toBe(0);
  expect(result.sideGrounded).toBe(false);
  expect(result.undersideY).toBeCloseTo(1.25);
  expect(result.undersideVelocity).toBe(0);
  expect(result.undersideGrounded).toBe(false);
  expect(result.platformY).toBe(2);
});
