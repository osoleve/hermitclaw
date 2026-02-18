#!/usr/bin/env python3
"""Generate MMBN-inspired pixel art assets for the Myxo tamagotchi room."""

from PIL import Image, ImageDraw
import os

TILE = 32
SPRITE = 48

# MMBN-inspired palette
C = {
    "void": (8, 12, 20),
    "panel_dark": (16, 28, 48),
    "panel_mid": (24, 44, 72),
    "panel_light": (32, 56, 88),
    "panel_edge": (48, 80, 120),
    "glow_teal": (0, 229, 160),
    "glow_teal_dim": (0, 140, 100),
    "glow_teal_vdim": (0, 80, 56),
    "glow_cyan": (0, 200, 255),
    "wall_dark": (12, 20, 36),
    "wall_mid": (20, 32, 56),
    "wall_accent": (32, 64, 112),
    "wall_line": (40, 80, 140),
    "neon_blue": (0, 100, 255),
    "neon_blue_dim": (0, 60, 160),
    "white": (255, 255, 255),
    "eye_white": (240, 245, 255),
    "slime_core": (0, 220, 155),
    "slime_mid": (0, 180, 130),
    "slime_edge": (0, 140, 100),
    "slime_dark": (0, 100, 72),
    "slime_highlight": (100, 255, 200),
    "slime_shadow": (0, 60, 44),
    "pupil": (20, 40, 60),
    "transparent": (0, 0, 0, 0),
    # Furniture accent colors
    "monitor_screen": (20, 60, 100),
    "monitor_glow": (40, 120, 200),
    "shelf_wood": (40, 32, 24),
    "shelf_light": (60, 48, 36),
    "book1": (180, 60, 60),
    "book2": (60, 60, 180),
    "book3": (60, 160, 80),
    "glass": (120, 180, 220),
    "glass_light": (180, 220, 240),
    "leaf_dark": (20, 80, 40),
    "leaf_mid": (40, 140, 60),
    "leaf_light": (80, 200, 100),
    "pot": (80, 56, 40),
    "bed_frame": (32, 48, 80),
    "bed_sheet": (60, 80, 120),
    "bed_pillow": (100, 120, 160),
    "nexus_glow1": (0, 200, 140),
    "nexus_glow2": (0, 160, 120),
}


def draw_floor_base(draw, ox, oy):
    """Dark cyber-grid floor panel."""
    # Fill with dark panel
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["panel_dark"])
    # Edge lines (MMBN grid look)
    draw.line([ox, oy, ox + 31, oy], fill=C["panel_edge"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["panel_edge"], width=1)
    # Inner subtle lines
    draw.line([ox + 1, oy + 1, ox + 30, oy + 1], fill=C["panel_mid"], width=1)
    draw.line([ox + 1, oy + 1, ox + 1, oy + 30], fill=C["panel_mid"], width=1)
    # Bottom-right dark edge
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["void"], width=1)
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["void"], width=1)


def draw_floor_variant(draw, ox, oy):
    """Floor variant with slight color difference."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["panel_dark"])
    draw.line([ox, oy, ox + 31, oy], fill=C["panel_edge"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["panel_edge"], width=1)
    draw.line([ox + 1, oy + 1, ox + 30, oy + 1], fill=C["panel_mid"], width=1)
    draw.line([ox + 1, oy + 1, ox + 1, oy + 30], fill=C["panel_mid"], width=1)
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["void"], width=1)
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["void"], width=1)
    # Small center detail
    draw.rectangle([ox + 13, oy + 13, ox + 18, oy + 18], fill=C["panel_mid"])


def draw_floor_glow(draw, ox, oy, frame):
    """Animated glowing floor panel (3 frames)."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["panel_dark"])
    draw.line([ox, oy, ox + 31, oy], fill=C["panel_edge"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["panel_edge"], width=1)
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["void"], width=1)
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["void"], width=1)
    # Glow center - varies by frame
    glow_colors = [C["glow_teal_vdim"], C["glow_teal_dim"], C["glow_teal"]]
    gc = glow_colors[frame]
    draw.rectangle([ox + 10, oy + 10, ox + 21, oy + 21], fill=gc)
    draw.rectangle([ox + 12, oy + 12, ox + 19, oy + 19], fill=C["panel_dark"])
    # Cross pattern in center
    draw.line([ox + 15, oy + 12, ox + 16, oy + 12], fill=gc, width=1)
    draw.line([ox + 15, oy + 19, ox + 16, oy + 19], fill=gc, width=1)
    draw.line([ox + 12, oy + 15, ox + 12, oy + 16], fill=gc, width=1)
    draw.line([ox + 19, oy + 15, ox + 19, oy + 16], fill=gc, width=1)


def draw_wall_top(draw, ox, oy):
    """Top wall panel."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    # Horizontal accent lines
    draw.line([ox, oy + 8, ox + 31, oy + 8], fill=C["wall_accent"], width=1)
    draw.line([ox, oy + 24, ox + 31, oy + 24], fill=C["wall_line"], width=1)
    # Top bright edge
    draw.line([ox, oy, ox + 31, oy], fill=C["wall_mid"], width=1)
    # Bottom dark edge
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["void"], width=1)
    # Vertical detail lines
    draw.line([ox + 8, oy + 8, ox + 8, oy + 24], fill=C["wall_mid"], width=1)
    draw.line([ox + 24, oy + 8, ox + 24, oy + 24], fill=C["wall_mid"], width=1)


def draw_wall_corner_tl(draw, ox, oy):
    """Top-left wall corner."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox, oy, ox + 31, oy], fill=C["wall_mid"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 8, oy + 8, ox + 8, oy + 24], fill=C["wall_accent"], width=1)
    draw.line([ox + 8, oy + 8, ox + 24, oy + 8], fill=C["wall_accent"], width=1)


def draw_wall_corner_tr(draw, ox, oy):
    """Top-right wall corner."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox, oy, ox + 31, oy], fill=C["wall_mid"], width=1)
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 24, oy + 8, ox + 24, oy + 24], fill=C["wall_accent"], width=1)
    draw.line([ox + 8, oy + 8, ox + 24, oy + 8], fill=C["wall_accent"], width=1)


def draw_wall_left(draw, ox, oy):
    """Left wall panel."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox, oy, ox, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 8, oy, ox + 8, oy + 31], fill=C["wall_accent"], width=1)
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["void"], width=1)


def draw_wall_right(draw, ox, oy):
    """Right wall panel."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 24, oy, ox + 24, oy + 31], fill=C["wall_accent"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["void"], width=1)


def draw_wall_bl(draw, ox, oy):
    """Bottom-left wall corner."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 8, oy + 8, ox + 8, oy + 24], fill=C["wall_accent"], width=1)
    draw.line([ox + 8, oy + 24, ox + 24, oy + 24], fill=C["wall_accent"], width=1)


def draw_wall_br(draw, ox, oy):
    """Bottom-right wall corner."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 8, oy + 24, ox + 24, oy + 24], fill=C["wall_accent"], width=1)
    draw.line([ox + 24, oy + 8, ox + 24, oy + 24], fill=C["wall_accent"], width=1)


def draw_desk(draw, ox, oy):
    """Terminal/monitor desk."""
    # Desk surface
    draw.rectangle([ox + 4, oy + 18, ox + 27, oy + 31], fill=C["wall_mid"])
    draw.line([ox + 4, oy + 18, ox + 27, oy + 18], fill=C["wall_line"], width=1)
    # Monitor
    draw.rectangle([ox + 8, oy + 4, ox + 24, oy + 17], fill=C["wall_dark"])
    draw.rectangle([ox + 9, oy + 5, ox + 23, oy + 15], fill=C["monitor_screen"])
    # Screen glow lines
    draw.line([ox + 11, oy + 8, ox + 21, oy + 8], fill=C["monitor_glow"], width=1)
    draw.line([ox + 11, oy + 11, ox + 18, oy + 11], fill=C["monitor_glow"], width=1)
    draw.line([ox + 11, oy + 13, ox + 20, oy + 13], fill=C["neon_blue_dim"], width=1)
    # Monitor stand
    draw.rectangle([ox + 14, oy + 16, ox + 17, oy + 18], fill=C["wall_accent"])
    # Keyboard
    draw.rectangle([ox + 10, oy + 22, ox + 22, oy + 25], fill=C["panel_mid"])
    for kx in range(11, 22, 2):
        draw.point((ox + kx, oy + 23), fill=C["panel_edge"])


def draw_bookshelf(draw, ox, oy):
    """Data shelf / server rack."""
    # Frame
    draw.rectangle([ox + 2, oy + 2, ox + 29, oy + 31], fill=C["shelf_wood"])
    draw.rectangle([ox + 3, oy + 3, ox + 28, oy + 30], fill=C["shelf_light"])
    # Shelves (horizontal dividers)
    for sy in [10, 18, 26]:
        draw.line([ox + 3, oy + sy, ox + 28, oy + sy], fill=C["shelf_wood"], width=1)
    # Books on shelves
    draw.rectangle([ox + 5, oy + 4, ox + 8, oy + 9], fill=C["book1"])
    draw.rectangle([ox + 9, oy + 5, ox + 11, oy + 9], fill=C["book2"])
    draw.rectangle([ox + 12, oy + 4, ox + 15, oy + 9], fill=C["book3"])
    draw.rectangle([ox + 17, oy + 6, ox + 19, oy + 9], fill=C["book1"])
    draw.rectangle([ox + 20, oy + 4, ox + 22, oy + 9], fill=C["neon_blue_dim"])
    # Second shelf items
    draw.rectangle([ox + 5, oy + 12, ox + 10, oy + 17], fill=C["monitor_screen"])
    draw.point((ox + 7, oy + 14), fill=C["glow_teal"])  # LED
    draw.rectangle([ox + 12, oy + 11, ox + 14, oy + 17], fill=C["book2"])
    draw.rectangle([ox + 16, oy + 12, ox + 20, oy + 17], fill=C["book3"])
    # Third shelf
    draw.rectangle([ox + 5, oy + 20, ox + 8, oy + 25], fill=C["book1"])
    draw.rectangle([ox + 10, oy + 19, ox + 15, oy + 25], fill=C["monitor_screen"])
    draw.point((ox + 12, oy + 22), fill=C["glow_teal"])  # LED
    draw.rectangle([ox + 17, oy + 20, ox + 22, oy + 25], fill=C["book2"])


def draw_window(draw, ox, oy):
    """Window / viewport on north wall."""
    # Window frame
    draw.rectangle([ox + 4, oy + 2, ox + 27, oy + 28], fill=C["wall_accent"])
    # Glass
    draw.rectangle([ox + 6, oy + 4, ox + 25, oy + 26], fill=C["glass"])
    # Stars/points of light in the glass
    for sx, sy in [(10, 8), (18, 12), (14, 20), (22, 6), (8, 16)]:
        draw.point((ox + sx, oy + sy), fill=C["glass_light"])
    # Cross bar
    draw.line([ox + 15, oy + 4, ox + 15, oy + 26], fill=C["wall_accent"], width=1)
    draw.line([ox + 6, oy + 14, ox + 25, oy + 14], fill=C["wall_accent"], width=1)
    # Sill
    draw.rectangle([ox + 3, oy + 28, ox + 28, oy + 30], fill=C["wall_line"])


def draw_plant(draw, ox, oy):
    """Digital/organic plant growth."""
    # Pot
    draw.rectangle([ox + 10, oy + 22, ox + 22, oy + 30], fill=C["pot"])
    draw.rectangle([ox + 8, oy + 20, ox + 24, oy + 22], fill=C["pot"])
    # Stem
    draw.line([ox + 16, oy + 10, ox + 16, oy + 22], fill=C["leaf_dark"], width=2)
    # Leaves
    draw.ellipse([ox + 10, oy + 6, ox + 18, oy + 14], fill=C["leaf_mid"])
    draw.ellipse([ox + 14, oy + 4, ox + 24, oy + 12], fill=C["leaf_dark"])
    draw.ellipse([ox + 12, oy + 8, ox + 20, oy + 16], fill=C["leaf_light"])
    # Glow spots (digital aspect)
    draw.point((ox + 14, oy + 8), fill=C["glow_teal"])
    draw.point((ox + 18, oy + 10), fill=C["glow_teal"])
    draw.point((ox + 16, oy + 6), fill=C["glow_teal_dim"])


def draw_bed(draw, ox, oy):
    """Rest pod / bed."""
    # Bed frame
    draw.rectangle([ox + 2, oy + 12, ox + 30, oy + 30], fill=C["bed_frame"])
    # Mattress
    draw.rectangle([ox + 4, oy + 14, ox + 28, oy + 28], fill=C["bed_sheet"])
    # Pillow
    draw.rectangle([ox + 6, oy + 14, ox + 14, oy + 20], fill=C["bed_pillow"])
    # Blanket fold
    draw.line([ox + 4, oy + 22, ox + 28, oy + 22], fill=C["bed_frame"], width=1)
    # Headboard
    draw.rectangle([ox + 2, oy + 8, ox + 30, oy + 12], fill=C["wall_mid"])
    draw.line([ox + 2, oy + 8, ox + 30, oy + 8], fill=C["wall_line"], width=1)
    # Tech detail on headboard
    draw.point((ox + 8, oy + 10), fill=C["glow_teal_dim"])
    draw.point((ox + 24, oy + 10), fill=C["glow_teal_dim"])


def draw_nexus(draw, ox, oy, frame=0):
    """Nexus pad - central Fold access point (animated)."""
    # Base pad
    draw.rectangle([ox + 4, oy + 4, ox + 27, oy + 27], fill=C["panel_mid"])
    # Inner ring
    gc = C["nexus_glow1"] if frame == 0 else C["nexus_glow2"]
    draw.rectangle([ox + 8, oy + 8, ox + 23, oy + 23], fill=C["panel_dark"])
    # Glowing pattern
    draw.rectangle([ox + 12, oy + 12, ox + 19, oy + 19], fill=gc)
    draw.rectangle([ox + 14, oy + 14, ox + 17, oy + 17], fill=C["panel_dark"])
    # Corner accents
    for cx, cy in [(9, 9), (22, 9), (9, 22), (22, 22)]:
        draw.point((ox + cx, oy + cy), fill=gc)
    # Edge lines
    draw.line([ox + 4, oy + 4, ox + 27, oy + 4], fill=C["panel_edge"], width=1)
    draw.line([ox + 4, oy + 4, ox + 4, oy + 27], fill=C["panel_edge"], width=1)


def draw_tech_panel(draw, ox, oy):
    """Generic tech/blocked panel."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    draw.line([ox, oy, ox + 31, oy], fill=C["wall_mid"], width=1)
    draw.line([ox, oy, ox, oy + 31], fill=C["wall_mid"], width=1)
    draw.line([ox + 31, oy, ox + 31, oy + 31], fill=C["void"], width=1)
    draw.line([ox, oy + 31, ox + 31, oy + 31], fill=C["void"], width=1)
    # Tech detail
    draw.rectangle([ox + 10, oy + 10, ox + 21, oy + 21], fill=C["wall_mid"])
    draw.point((ox + 15, oy + 15), fill=C["neon_blue_dim"])


def draw_server_unit(draw, ox, oy):
    """Server rack unit."""
    draw.rectangle([ox + 4, oy + 2, ox + 27, oy + 30], fill=C["wall_dark"])
    for sy in [6, 12, 18, 24]:
        draw.rectangle([ox + 6, oy + sy, ox + 25, oy + sy + 3], fill=C["wall_mid"])
        draw.point((ox + 8, oy + sy + 1), fill=C["glow_teal"])
        draw.line([ox + 12, oy + sy + 1, ox + 23, oy + sy + 1], fill=C["panel_edge"], width=1)


def draw_cable_conduit(draw, ox, oy):
    """Cable conduit / pipe."""
    draw.rectangle([ox, oy, ox + 31, oy + 31], fill=C["wall_dark"])
    # Vertical conduit
    draw.rectangle([ox + 12, oy, ox + 19, oy + 31], fill=C["wall_mid"])
    draw.line([ox + 12, oy, ox + 12, oy + 31], fill=C["wall_accent"], width=1)
    draw.line([ox + 19, oy, ox + 19, oy + 31], fill=C["wall_accent"], width=1)
    # Data flow lights
    for sy in [4, 12, 20, 28]:
        draw.point((ox + 15, oy + sy), fill=C["glow_teal_dim"])


def generate_tileset():
    """Generate the room tileset PNG."""
    # Layout: 8 columns, 4 rows of 32x32 tiles
    # Row 0: floor tiles (base, variant, glow frame 0, glow frame 1, glow frame 2)
    # Row 1: wall tiles (top, corner-tl, corner-tr, left, right, bottom-l, bottom-r)
    # Row 2: furniture (desk, bookshelf, window, plant, bed, nexus f0, nexus f1)
    # Row 3: decorative (tech panel, server, cable)

    width = 8 * TILE  # 256
    height = 4 * TILE  # 128
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Row 0: Floor tiles
    draw_floor_base(draw, 0, 0)
    draw_floor_variant(draw, TILE, 0)
    for frame in range(3):
        draw_floor_glow(draw, (2 + frame) * TILE, 0, frame)

    # Row 1: Wall tiles
    draw_wall_top(draw, 0, TILE)
    draw_wall_corner_tl(draw, TILE, TILE)
    draw_wall_corner_tr(draw, 2 * TILE, TILE)
    draw_wall_left(draw, 3 * TILE, TILE)
    draw_wall_right(draw, 4 * TILE, TILE)
    draw_wall_bl(draw, 5 * TILE, TILE)
    draw_wall_br(draw, 6 * TILE, TILE)

    # Row 2: Furniture
    draw_desk(draw, 0, 2 * TILE)
    draw_bookshelf(draw, TILE, 2 * TILE)
    draw_window(draw, 2 * TILE, 2 * TILE)
    draw_plant(draw, 3 * TILE, 2 * TILE)
    draw_bed(draw, 4 * TILE, 2 * TILE)
    draw_nexus(draw, 5 * TILE, 2 * TILE, frame=0)
    draw_nexus(draw, 6 * TILE, 2 * TILE, frame=1)

    # Row 3: Decorative
    draw_tech_panel(draw, 0, 3 * TILE)
    draw_server_unit(draw, TILE, 3 * TILE)
    draw_cable_conduit(draw, 2 * TILE, 3 * TILE)

    return img


# --- Slime sprite generation ---

def draw_slime_body(draw, cx, cy, r, body_color, highlight_color, shadow_color, squash_x=1.0, squash_y=1.0):
    """Draw a slime blob body."""
    rx = int(r * squash_x)
    ry = int(r * squash_y)
    # Shadow
    draw.ellipse([cx - rx, cy - ry + 2, cx + rx, cy + ry + 2], fill=shadow_color)
    # Main body
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=body_color)
    # Highlight
    hx = int(rx * 0.4)
    hy = int(ry * 0.4)
    draw.ellipse([cx - hx - 2, cy - hy - 2, cx + hx - 2, cy + hy - 3], fill=highlight_color)


def draw_slime_eyes(draw, cx, cy, eye_y_offset=-4, open=True, look_x=0, look_y=0):
    """Draw slime eyes."""
    lex = cx - 5 + look_x
    rex = cx + 5 + look_x
    ey = cy + eye_y_offset + look_y

    if open:
        # White of eyes
        draw.ellipse([lex - 3, ey - 2, lex + 3, ey + 2], fill=C["eye_white"])
        draw.ellipse([rex - 3, ey - 2, rex + 3, ey + 2], fill=C["eye_white"])
        # Pupils
        draw.ellipse([lex - 1 + look_x, ey - 1 + look_y, lex + 1 + look_x, ey + 1 + look_y], fill=C["pupil"])
        draw.ellipse([rex - 1 + look_x, ey - 1 + look_y, rex + 1 + look_x, ey + 1 + look_y], fill=C["pupil"])
    else:
        # Closed eyes (sleeping)
        draw.line([lex - 3, ey, lex + 3, ey], fill=C["pupil"], width=1)
        draw.line([rex - 3, ey, rex + 3, ey], fill=C["pupil"], width=1)


def draw_slime_mouth(draw, cx, cy, mouth_y=2):
    """Small happy mouth."""
    my = cy + mouth_y
    draw.arc([cx - 3, my - 1, cx + 3, my + 3], 0, 180, fill=C["pupil"], width=1)


def generate_slime_sheet():
    """Generate the slime creature sprite sheet.

    Layout: 9 rows x 4 columns of 48x48 frames
    Row 0: idle (4 frames - bounce)
    Row 1: walk_down (4 frames)
    Row 2: walk_up (4 frames)
    Row 3: walk_side (4 frames)
    Row 4: think (4 frames - with orbiting dots)
    Row 5: reflect (4 frames - sparkles)
    Row 6: plan (4 frames - hexagon overlay)
    Row 7: sleep (2 frames + 2 blank)
    Row 8: converse (4 frames - speech motion)
    """
    cols = 4
    rows = 9
    width = cols * SPRITE
    height = rows * SPRITE
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    S = SPRITE
    R = 12  # base radius

    # Helper for center of each frame
    def fc(col, row):
        return (col * S + S // 2, row * S + S // 2 + 4)  # slightly below center for ground feel

    # --- Row 0: Idle (4 frames - gentle bounce) ---
    for f in range(4):
        cx, cy = fc(f, 0)
        bounce = [0, -2, -3, -1][f]
        # Ground shadow
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy + bounce, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"])
        draw_slime_eyes(draw, cx, cy + bounce)
        draw_slime_mouth(draw, cx, cy + bounce)

    # --- Row 1: Walk down (4 frames) ---
    for f in range(4):
        cx, cy = fc(f, 1)
        bounce = [-1, 0, -1, -2][f]
        sx = [1.0, 1.1, 1.0, 0.9][f]
        sy = [1.0, 0.9, 1.0, 1.1][f]
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy + bounce, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"], sx, sy)
        draw_slime_eyes(draw, cx, cy + bounce, look_y=1)
        draw_slime_mouth(draw, cx, cy + bounce, mouth_y=3)

    # --- Row 2: Walk up (4 frames) ---
    for f in range(4):
        cx, cy = fc(f, 2)
        bounce = [-1, 0, -1, -2][f]
        sx = [1.0, 1.1, 1.0, 0.9][f]
        sy = [1.0, 0.9, 1.0, 1.1][f]
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy + bounce, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"], sx, sy)
        draw_slime_eyes(draw, cx, cy + bounce, look_y=-1)

    # --- Row 3: Walk side (4 frames - flip horizontally for other direction) ---
    for f in range(4):
        cx, cy = fc(f, 3)
        bounce = [-1, 0, -1, -2][f]
        sx = [1.0, 0.9, 1.0, 1.1][f]
        sy = [1.0, 1.1, 1.0, 0.9][f]
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy + bounce, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"], sx, sy)
        draw_slime_eyes(draw, cx, cy + bounce, look_x=2)
        draw_slime_mouth(draw, cx, cy + bounce)

    # --- Row 4: Think (4 frames - orbiting dots) ---
    import math
    for f in range(4):
        cx, cy = fc(f, 4)
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"])
        draw_slime_eyes(draw, cx, cy, look_y=-1)
        # Orbiting dots above head
        for i in range(3):
            angle = (f * math.pi / 2) + (i * 2 * math.pi / 3)
            dx = int(math.cos(angle) * 10)
            dy = int(math.sin(angle) * 4)
            draw.ellipse([cx + dx - 2, cy - R - 8 + dy - 2, cx + dx + 2, cy - R - 8 + dy + 2],
                        fill=C["glow_teal"])

    # --- Row 5: Reflect (4 frames - sparkle effect) ---
    for f in range(4):
        cx, cy = fc(f, 5)
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        # Slightly different body color for reflect
        draw_slime_body(draw, cx, cy, R, (130, 110, 200), (180, 160, 240), (80, 60, 140))
        draw_slime_eyes(draw, cx, cy)
        # Sparkle particles around
        spark_positions = [
            [(-12, -10), (14, -6), (-8, 8), (10, 10)],
            [(-10, -12), (12, -8), (-14, 6), (8, 12)],
            [(-14, -8), (10, -12), (-10, 10), (14, 6)],
            [(-8, -14), (14, -10), (-12, 8), (10, 8)],
        ][f]
        for sx, sy in spark_positions:
            draw.rectangle([cx + sx - 1, cy + sy - 1, cx + sx + 1, cy + sy + 1], fill=(167, 139, 250))

    # --- Row 6: Plan (4 frames - hexagon overlay) ---
    for f in range(4):
        cx, cy = fc(f, 6)
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy, R, (30, 170, 120), (80, 220, 160), (10, 100, 70))
        draw_slime_eyes(draw, cx, cy, look_y=-1)
        # Hexagon outline (rotates per frame)
        hex_r = 18
        offset = f * math.pi / 12
        pts = []
        for i in range(6):
            a = offset + i * math.pi / 3
            pts.append((cx + int(math.cos(a) * hex_r), cy + int(math.sin(a) * hex_r)))
        # Draw hexagon edges
        gc = (52, 211, 153)
        for i in range(6):
            draw.line([pts[i], pts[(i + 1) % 6]], fill=gc, width=1)

    # --- Row 7: Sleep (2 frames + 2 blank) ---
    for f in range(2):
        cx, cy = fc(f, 7)
        # Slightly squashed (resting)
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        squash = [1.1, 1.15][f]
        draw_slime_body(draw, cx, cy + 2, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"],
                       squash_x=squash, squash_y=1.0 / squash)
        draw_slime_eyes(draw, cx, cy + 2, open=False)
        # Z's
        zx = cx + 12
        zy = cy - R - 4 + (f * 3)
        draw.text((zx, zy), "z", fill=C["glow_teal_dim"])
        if f == 1:
            draw.text((zx + 6, zy - 6), "z", fill=C["glow_teal_vdim"])

    # --- Row 8: Converse (4 frames - speech motion) ---
    for f in range(4):
        cx, cy = fc(f, 8)
        bounce = [0, -1, 0, 1][f]
        draw.ellipse([cx - 10, cy + R - 2, cx + 10, cy + R + 2], fill=C["slime_shadow"])
        draw_slime_body(draw, cx, cy + bounce, R, C["slime_mid"], C["slime_highlight"], C["slime_dark"])
        draw_slime_eyes(draw, cx, cy + bounce)
        # Mouth open/close animation
        mouth_open = [2, 4, 2, 0][f]
        my = cy + bounce + 2
        if mouth_open > 0:
            draw.ellipse([cx - 3, my, cx + 3, my + mouth_open], fill=C["pupil"])
        else:
            draw_slime_mouth(draw, cx, cy + bounce)
        # Speech bubble indicator
        if f in [0, 2]:
            bx, by = cx + 14, cy - 12
            draw.rectangle([bx, by, bx + 8, by + 6], fill=C["eye_white"])
            draw.point((bx - 1, by + 4), fill=C["eye_white"])

    return img


if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "assets")

    tiles_dir = os.path.join(out_dir, "tiles")
    sprites_dir = os.path.join(out_dir, "sprites")
    os.makedirs(tiles_dir, exist_ok=True)
    os.makedirs(sprites_dir, exist_ok=True)

    tileset = generate_tileset()
    tileset_path = os.path.join(tiles_dir, "room-tileset.png")
    tileset.save(tileset_path)
    print(f"Tileset saved: {tileset_path} ({tileset.size[0]}x{tileset.size[1]})")

    slime = generate_slime_sheet()
    slime_path = os.path.join(sprites_dir, "slime-sheet.png")
    slime.save(slime_path)
    print(f"Slime sheet saved: {slime_path} ({slime.size[0]}x{slime.size[1]})")
