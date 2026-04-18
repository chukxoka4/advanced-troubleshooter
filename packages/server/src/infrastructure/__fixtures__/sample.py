ORIGIN = (0, 0)


def distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


class Vec:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def length(self):
        return (self.x ** 2 + self.y ** 2) ** 0.5
